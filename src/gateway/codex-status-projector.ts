import WebSocket from 'ws';
import pkg from '../../package.json';
import {
  CodexAppServerInfo,
  CodexAppServerDaemonManager,
  DefaultCodexAppServerDaemonManager
} from '../backends/codex-appserver';
import { createDefaultSessionStore, SessionStore } from '../session-store';
import { CodexTurnStatus, StoredSession } from '../types';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 500;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_SERVER_CHECK_INTERVAL_MS = 5_000;

const PROJECTOR_NOTIFICATION_OPT_OUTS = [
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'turn/diff/updated',
  'turn/plan/updated',
  'thread/tokenUsage/updated',
  'rawResponse/completed'
];

type ThreadRuntimeStatus = 'active' | 'idle' | 'notLoaded' | 'systemError' | 'unknown';

interface JsonRpcError {
  message?: string;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

export interface CodexProjectionNotification {
  method: string;
  params?: unknown;
}

export interface CodexProjectionRpcClient {
  readonly serverUserAgent?: string;
  connectAndInitialize(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  waitForClose(): Promise<Error | undefined>;
  close(): Promise<void>;
}

export type CodexProjectionClientFactory = (
  url: string,
  onNotification: (notification: CodexProjectionNotification) => void
) => CodexProjectionRpcClient;

/**
 * A small app-server client for status projection. It does not keep turn text,
 * item payloads, or per-thread history in memory.
 */
export class CodexProjectionWebSocketClient implements CodexProjectionRpcClient {
  private ws?: WebSocket;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly closedPromise: Promise<Error | undefined>;
  private resolveClosed!: (error: Error | undefined) => void;
  private closed = false;
  private closing = false;
  private initializedServerUserAgent?: string;

  constructor(
    private readonly url: string,
    private readonly onNotification: (notification: CodexProjectionNotification) => void,
    private readonly requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    private readonly closeTimeoutMs: number = DEFAULT_CLOSE_TIMEOUT_MS
  ) {
    this.closedPromise = new Promise<Error | undefined>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async connectAndInitialize(): Promise<void> {
    await this.connect();
    const initializeResult = await this.request('initialize', {
      clientInfo: {
        name: 'dev-sessions',
        title: 'dev-sessions status projector',
        version: pkg.version
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: PROJECTOR_NOTIFICATION_OPT_OUTS
      }
    });
    const userAgent = initializeResult && typeof initializeResult === 'object'
      ? (initializeResult as Record<string, unknown>).userAgent
      : undefined;
    this.initializedServerUserAgent = typeof userAgent === 'string' ? userAgent : undefined;
    this.notify('initialized', {});
  }

  get serverUserAgent(): string | undefined {
    return this.initializedServerUserAgent;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error('Codex app-server projection connection is closed');
    }

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server projection connection is not open');
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }

        this.pendingRequests.delete(id);
        pending.reject(new Error(`${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timeoutHandle
      });

      try {
        ws.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error: unknown) {
        this.pendingRequests.delete(id);
        clearTimeout(timeoutHandle);
        reject(error as Error);
      }
    });
  }

  waitForClose(): Promise<Error | undefined> {
    return this.closedPromise;
  }

  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.finishClose();
      return;
    }

    this.closing = true;

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      const timeoutHandle = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // The socket is already closed.
        }
        finish();
      }, this.closeTimeoutMs);

      ws.once('close', () => {
        clearTimeout(timeoutHandle);
        finish();
      });

      try {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
          clearTimeout(timeoutHandle);
          finish();
          return;
        }

        ws.close();
      } catch {
        clearTimeout(timeoutHandle);
        finish();
      }
    });

    this.finishClose();
  }

  private async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        perMessageDeflate: false,
        handshakeTimeout: this.requestTimeoutMs
      });
      this.ws = ws;

      const onOpen = () => {
        cleanup();
        this.attachSocketHandlers(ws);
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = (code: number, reason: Buffer) => {
        cleanup();
        const error = this.createCloseError(code, reason, ' during connect');
        this.finishClose(error);
        reject(error);
      };
      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('error', onError);
        ws.off('close', onClose);
      };

      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.once('close', onClose);
    });
  }

  private attachSocketHandlers(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.RawData) => {
      const frame = typeof data === 'string' ? data : data.toString();
      for (const line of frame.split('\n')) {
        this.handleJsonLine(line);
      }
    });

    ws.on('error', (error: Error) => {
      this.finishClose(new Error(`Codex app-server projection websocket error: ${error.message}`));
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const error = this.closing ? undefined : this.createCloseError(code, reason);
      this.finishClose(error);
    });
  }

  private handleJsonLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!payload || typeof payload !== 'object') {
      return;
    }

    if ('id' in payload && typeof (payload as { id?: unknown }).id === 'number') {
      this.handleResponse(payload as JsonRpcResponse);
      return;
    }

    const method = (payload as { method?: unknown }).method;
    if (typeof method === 'string') {
      this.onNotification({
        method,
        params: (payload as { params?: unknown }).params
      });
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeoutHandle);

    if (response.error) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message ?? 'Unknown JSON-RPC error'}`));
      return;
    }

    pending.resolve(response.result);
  }

  private notify(method: string, params?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private finishClose(error?: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const pendingRequests = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const pending of pendingRequests) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error ?? new Error('Codex app-server projection connection closed'));
    }
    this.resolveClosed(error);
  }

  private createCloseError(code: number, reason: Buffer, context: string = ''): Error {
    const details = reason.toString().trim();
    const suffix = details.length > 0 ? `: ${details}` : '';
    return new Error(`Codex app-server projection websocket closed${context} (${code})${suffix}`);
  }
}

export interface CodexStatusProjectorControl {
  start(): void;
  stop(): Promise<void>;
  getStatus(): CodexStatusProjectorStatus;
}

export interface CodexStatusProjectorStatus {
  state: 'stopped' | 'waiting' | 'connected' | 'reconnecting';
  appServerPid?: number;
  appServerUrl?: string;
  appServerUserAgent?: string;
  lastConnectedAt?: string;
  lastReconciledAt?: string;
  lastError?: string;
}

interface ProjectorLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface CodexStatusProjectorOptions {
  store?: SessionStore;
  daemonManager?: Pick<CodexAppServerDaemonManager, 'getServer'>;
  clientFactory?: CodexProjectionClientFactory;
  reconnectDelayMs?: number;
  serverCheckIntervalMs?: number;
  logger?: ProjectorLogger;
  now?: () => Date;
}

export class CodexStatusProjector implements CodexStatusProjectorControl {
  private readonly store: SessionStore;
  private readonly daemonManager: Pick<CodexAppServerDaemonManager, 'getServer'>;
  private readonly clientFactory: CodexProjectionClientFactory;
  private readonly reconnectDelayMs: number;
  private readonly serverCheckIntervalMs: number;
  private readonly logger: ProjectorLogger;
  private readonly now: () => Date;
  private readonly championIdByThreadId = new Map<string, string>();
  private eventQueue: Promise<void> = Promise.resolve();
  private runPromise?: Promise<void>;
  private activeClient?: CodexProjectionRpcClient;
  private stopRequested = false;
  private generation = 0;
  private status: CodexStatusProjectorStatus = { state: 'stopped' };

  constructor(options: CodexStatusProjectorOptions = {}) {
    this.store = options.store ?? createDefaultSessionStore();
    this.daemonManager = options.daemonManager ?? new DefaultCodexAppServerDaemonManager();
    this.clientFactory = options.clientFactory ?? (
      (url, onNotification) => new CodexProjectionWebSocketClient(url, onNotification)
    );
    this.reconnectDelayMs = Math.max(1, options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
    this.serverCheckIntervalMs = Math.max(1, options.serverCheckIntervalMs ?? DEFAULT_SERVER_CHECK_INTERVAL_MS);
    this.logger = options.logger ?? {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message)
    };
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.runPromise) {
      return;
    }

    this.stopRequested = false;
    this.status = { state: 'waiting' };
    this.runPromise = this.run().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { state: 'reconnecting', lastError: message };
      this.logger.warn(`[gateway] Codex status projector stopped after an unexpected error: ${message}`);
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.generation += 1;
    await this.activeClient?.close().catch(() => {
      // The projector is already stopping.
    });
    await this.runPromise;
    await this.eventQueue;
    this.activeClient = undefined;
    this.runPromise = undefined;
    this.status = { state: 'stopped' };
  }

  getStatus(): CodexStatusProjectorStatus {
    return { ...this.status };
  }

  private async run(): Promise<void> {
    while (!this.stopRequested) {
      let server: CodexAppServerInfo | undefined;
      try {
        server = await this.daemonManager.getServer();
      } catch (error: unknown) {
        this.noteConnectionError(error);
      }

      if (!server) {
        if (!this.stopRequested) {
          this.status = { state: 'waiting' };
          await this.delay(this.reconnectDelayMs);
        }
        continue;
      }

      try {
        await this.runConnected(server);
      } catch (error: unknown) {
        if (!this.stopRequested) {
          this.noteConnectionError(error);
        }
      }

      if (!this.stopRequested) {
        await this.delay(this.reconnectDelayMs);
      }
    }
  }

  private async runConnected(server: CodexAppServerInfo): Promise<void> {
    const generation = this.generation + 1;
    this.generation = generation;
    const client = this.clientFactory(server.url, (notification) => {
      this.enqueue(generation, async () => this.handleNotification(client, notification));
    });
    this.activeClient = client;

    try {
      await client.connectAndInitialize();
      if (this.stopRequested || generation !== this.generation) {
        return;
      }

      this.status = {
        state: 'connected',
        appServerPid: server.pid,
        appServerUrl: server.url,
        ...(client.serverUserAgent ? { appServerUserAgent: client.serverUserAgent } : {}),
        lastConnectedAt: this.now().toISOString()
      };
      this.logger.info(`[gateway] Codex status projector connected pid=${server.pid} url=${server.url}`);

      await this.enqueue(generation, async () => this.reconcileAfterConnect(client));

      const stopServerMonitor = this.startServerMonitor(client, server, generation);
      const closeError = await client.waitForClose();
      stopServerMonitor();
      if (closeError) {
        throw closeError;
      }
    } finally {
      if (this.activeClient === client) {
        this.activeClient = undefined;
      }
      await client.close().catch(() => {
        // A reconnect will use the next app-server state.
      });
      await this.eventQueue;
    }
  }

  private async reconcileAfterConnect(client: CodexProjectionRpcClient): Promise<void> {
    const sessions = await this.refreshSessionIndex();
    const threadIds = new Set(
      sessions
        .filter((session) => session.codexTurnInProgress === true || Boolean(session.codexActiveTurnId))
        .map((session) => session.internalId)
    );

    try {
      const loadedResult = await client.request('thread/loaded/list', {});
      for (const threadId of extractLoadedThreadIds(loadedResult)) {
        if (this.championIdByThreadId.has(threadId)) {
          threadIds.add(threadId);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { ...this.status, lastError: `Could not list loaded threads: ${message}` };
      this.logger.warn(`[gateway] Codex status projector could not list loaded threads: ${message}`);
    }

    for (const threadId of threadIds) {
      if (this.stopRequested) {
        return;
      }
      await this.reconcileThread(client, threadId);
    }

    this.status = {
      ...this.status,
      lastReconciledAt: this.now().toISOString()
    };
  }

  private async handleNotification(
    client: CodexProjectionRpcClient,
    notification: CodexProjectionNotification
  ): Promise<void> {
    if (notification.method === 'thread/status/changed') {
      const threadId = extractNotificationThreadId(notification.params);
      const status = extractStatusValue(
        notification.params && typeof notification.params === 'object'
          ? (notification.params as Record<string, unknown>).status
          : undefined
      );
      if (!threadId || status === 'unknown') {
        return;
      }

      if (status === 'active') {
        await this.applyRuntimeStatus(threadId, status);
      } else {
        await this.reconcileThread(client, threadId);
      }
      return;
    }

    if (notification.method === 'thread/started') {
      const thread = notification.params && typeof notification.params === 'object'
        ? (notification.params as Record<string, unknown>).thread
        : undefined;
      const threadId = extractThreadId(thread);
      const status = thread && typeof thread === 'object'
        ? extractStatusValue((thread as Record<string, unknown>).status)
        : 'unknown';
      if (threadId && status !== 'unknown') {
        await this.applyRuntimeStatus(threadId, status);
      }
      return;
    }

    if (notification.method === 'turn/started') {
      const threadId = extractNotificationThreadId(notification.params);
      const turn = notification.params && typeof notification.params === 'object'
        ? (notification.params as Record<string, unknown>).turn
        : undefined;
      const turnId = extractThreadId(turn);
      if (threadId) {
        await this.applyTurnStarted(threadId, turnId);
      }
      return;
    }

    if (notification.method === 'turn/completed') {
      const threadId = extractNotificationThreadId(notification.params);
      const turn = notification.params && typeof notification.params === 'object'
        ? (notification.params as Record<string, unknown>).turn
        : undefined;
      const turnId = extractThreadId(turn);
      const turnStatus = extractTurnStatus(turn);
      if (threadId && turnStatus) {
        const applied = await this.applyTurnCompleted(threadId, turnId, turnStatus, extractTurnError(turn));
        if (applied === 'reconcile') {
          await this.reconcileThread(client, threadId);
        }
      }
    }
  }

  private async applyTurnStarted(threadId: string, turnId?: string): Promise<void> {
    const championId = await this.findChampionId(threadId);
    if (!championId) {
      return;
    }

    await this.store.updateSessionAtomically(championId, (current) => {
      if (
        current.codexTurnInProgress === true &&
        current.codexActiveTurnId === turnId &&
        current.lastTurnStatus === undefined &&
        current.lastTurnError === undefined
      ) {
        return undefined;
      }

      return {
        codexTurnInProgress: true,
        codexActiveTurnId: turnId,
        lastTurnStatus: undefined,
        lastTurnError: undefined,
        lastUsed: this.now().toISOString()
      };
    });
  }

  private async applyTurnCompleted(
    threadId: string,
    turnId: string | undefined,
    turnStatus: CodexTurnStatus,
    errorMessage?: string
  ): Promise<'applied' | 'ignored' | 'reconcile'> {
    const championId = await this.findChampionId(threadId);
    if (!championId) {
      return 'ignored';
    }

    let result: 'applied' | 'ignored' | 'reconcile' = 'ignored';
    const completedAt = this.now().toISOString();
    await this.store.updateSessionAtomically(championId, (current) => {
      if (
        current.codexActiveTurnId &&
        turnId &&
        current.codexActiveTurnId !== turnId
      ) {
        result = 'ignored';
        return undefined;
      }

      if (!current.codexActiveTurnId) {
        result = current.codexTurnInProgress === true ? 'reconcile' : 'ignored';
        return undefined;
      }

      if (!turnId) {
        result = 'reconcile';
        return undefined;
      }

      result = 'applied';
      return {
        codexTurnInProgress: false,
        codexActiveTurnId: undefined,
        codexLastCompletedAt: completedAt,
        lastTurnStatus: turnStatus,
        lastTurnError: turnStatus === 'failed' ? errorMessage ?? 'Codex turn failed' : undefined,
        lastUsed: completedAt
      };
    });
    return result;
  }

  private async reconcileThread(client: CodexProjectionRpcClient, threadId: string): Promise<void> {
    const championId = await this.findChampionId(threadId);
    if (!championId) {
      return;
    }

    let status: ThreadRuntimeStatus;
    try {
      const result = await client.request('thread/read', {
        threadId,
        includeTurns: false
      });
      status = extractThreadRuntimeStatus(result);
    } catch (error: unknown) {
      if (isThreadNotFoundError(error)) {
        status = 'notLoaded';
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.status = { ...this.status, lastError: `Could not read thread ${threadId}: ${message}` };
        this.logger.warn(`[gateway] Codex status projector could not read thread ${threadId}: ${message}`);
        return;
      }
    }

    await this.applyRuntimeStatus(threadId, status, championId);
  }

  private async applyRuntimeStatus(
    threadId: string,
    status: ThreadRuntimeStatus,
    knownChampionId?: string
  ): Promise<void> {
    if (status === 'unknown') {
      return;
    }

    const championId = knownChampionId ?? await this.findChampionId(threadId);
    if (!championId) {
      return;
    }

    await this.store.updateSessionAtomically(championId, (current) => {
      if (status === 'active') {
        if (
          current.codexTurnInProgress === true &&
          current.lastTurnStatus === undefined &&
          current.lastTurnError === undefined
        ) {
          return undefined;
        }

        return {
          codexTurnInProgress: true,
          lastTurnStatus: undefined,
          lastTurnError: undefined,
          lastUsed: this.now().toISOString()
        };
      }

      if (status === 'systemError') {
        const lastTurnError = current.lastTurnStatus === 'failed' && current.lastTurnError
          ? current.lastTurnError
          : 'Codex app-server is in a system error state';
        if (
          current.codexTurnInProgress === false &&
          !current.codexActiveTurnId &&
          current.lastTurnStatus === 'failed' &&
          current.lastTurnError === lastTurnError
        ) {
          return undefined;
        }

        return {
          codexTurnInProgress: false,
          codexActiveTurnId: undefined,
          lastTurnStatus: 'failed',
          lastTurnError
        };
      }

      if (current.codexTurnInProgress !== true && !current.codexActiveTurnId) {
        return undefined;
      }

      return {
        codexTurnInProgress: false,
        codexActiveTurnId: undefined
      };
    });
  }

  private async findChampionId(threadId: string): Promise<string | undefined> {
    const known = this.championIdByThreadId.get(threadId);
    if (known) {
      return known;
    }

    await this.refreshSessionIndex();
    return this.championIdByThreadId.get(threadId);
  }

  private async refreshSessionIndex(): Promise<StoredSession[]> {
    const sessions = (await this.store.listSessions()).filter(
      (session) => session.cli === 'codex' && !session.host
    );
    this.championIdByThreadId.clear();
    for (const session of sessions) {
      this.championIdByThreadId.set(session.internalId, session.championId);
    }
    return sessions;
  }

  private enqueue(generation: number, operation: () => Promise<void>): Promise<void> {
    const next = this.eventQueue.then(async () => {
      if (this.stopRequested || generation !== this.generation) {
        return;
      }
      await operation();
    });
    this.eventQueue = next.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { ...this.status, lastError: `Projection event failed: ${message}` };
      this.logger.warn(`[gateway] Codex status projector event failed: ${message}`);
    });
    return this.eventQueue;
  }

  private startServerMonitor(
    client: CodexProjectionRpcClient,
    expectedServer: CodexAppServerInfo,
    generation: number
  ): () => void {
    let checking = false;
    const intervalHandle = setInterval(() => {
      if (checking || this.stopRequested || generation !== this.generation) {
        return;
      }

      checking = true;
      void this.daemonManager.getServer()
        .then(async (currentServer) => {
          if (
            !currentServer ||
            currentServer.pid !== expectedServer.pid ||
            currentServer.url !== expectedServer.url
          ) {
            await client.close();
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.status = { ...this.status, lastError: `Could not check app-server state: ${message}` };
          this.logger.warn(`[gateway] Codex status projector could not check app-server state: ${message}`);
        })
        .finally(() => {
          checking = false;
        });
    }, this.serverCheckIntervalMs);

    return () => clearInterval(intervalHandle);
  }

  private async delay(ms: number): Promise<void> {
    if (this.stopRequested) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private noteConnectionError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.status = {
      state: 'reconnecting',
      lastError: message
    };
    this.logger.warn(`[gateway] Codex status projector will reconnect: ${message}`);
  }
}

function extractNotificationThreadId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const threadId = record.threadId ?? record.thread_id;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined;
}

function extractThreadId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function extractStatusValue(value: unknown): ThreadRuntimeStatus {
  if (value === 'active' || value === 'idle' || value === 'notLoaded' || value === 'systemError') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return 'unknown';
  }

  const record = value as Record<string, unknown>;
  if ('active' in record) {
    return 'active';
  }
  if (
    record.type === 'active' ||
    record.type === 'idle' ||
    record.type === 'notLoaded' ||
    record.type === 'systemError'
  ) {
    return record.type;
  }
  return 'unknown';
}

function extractThreadRuntimeStatus(result: unknown): ThreadRuntimeStatus {
  if (!result || typeof result !== 'object') {
    return 'unknown';
  }
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== 'object') {
    return 'unknown';
  }
  return extractStatusValue((thread as Record<string, unknown>).status);
}

function extractLoadedThreadIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') {
    return [];
  }
  const data = (result as Record<string, unknown>).data;
  return Array.isArray(data)
    ? data.filter((threadId): threadId is string => typeof threadId === 'string' && threadId.length > 0)
    : [];
}

function extractTurnStatus(turn: unknown): CodexTurnStatus | undefined {
  if (!turn || typeof turn !== 'object') {
    return undefined;
  }
  const status = (turn as Record<string, unknown>).status;
  return status === 'completed' || status === 'failed' || status === 'interrupted'
    ? status
    : undefined;
}

function extractTurnError(turn: unknown): string | undefined {
  if (!turn || typeof turn !== 'object') {
    return undefined;
  }
  const error = (turn as Record<string, unknown>).error;
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && /thread not loaded|thread not found|no rollout found|unknown thread/i.test(error.message);
}
