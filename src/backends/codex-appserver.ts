import { ChildProcess, spawn } from 'node:child_process';
import { mkdir, open as openFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { AgentTurnStatus } from '../types';

type TurnCompletionStatus = 'completed' | 'failed' | 'interrupted';

interface JsonRpcError {
  code?: number;
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

interface TurnWaiter {
  startTime: number;
  timeoutHandle: NodeJS.Timeout;
  expectedThreadId?: string;
  expectedTurnId?: string;
  resolve: (result: CodexTurnWaitResult) => void;
}

interface SessionState {
  assistantHistory: string[];
  lastTurnStatus?: TurnCompletionStatus;
  lastTurnError?: string;
}

interface CodexAppServerStateFile {
  version: number;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
}

export interface CodexAppServerInfo {
  pid: number;
  port: number;
  url: string;
}

export interface CodexSessionCreateResult {
  threadId: string;
  model: string;
  appServerPid: number;
  appServerPort: number;
}

export interface CodexTurnWaitResult {
  completed: boolean;
  timedOut: boolean;
  elapsedMs: number;
  status: TurnCompletionStatus;
  errorMessage?: string;
  assistantText?: string;
}

export interface CodexSendMessageOptions {
  workspacePath: string;
  model?: string;
}

export interface CodexSendResult {
  threadId: string;
  appServerPid: number;
  appServerPort: number;
  turnId?: string;
  assistantText?: string;
}

export interface CodexRpcClient {
  readonly currentTurnText: string;
  readonly lastTurnStatus?: TurnCompletionStatus;
  readonly lastTurnError?: string;
  connectAndInitialize(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  waitForTurnCompletion(timeoutMs: number, expectedThreadId?: string, expectedTurnId?: string): Promise<CodexTurnWaitResult>;
  close(): Promise<void>;
}

export interface CodexAppServerDaemonManager {
  ensureServer(): Promise<CodexAppServerInfo>;
  getServer(): Promise<CodexAppServerInfo | undefined>;
  isServerRunning(pid?: number, port?: number): Promise<boolean>;
  resetServer(server?: CodexAppServerInfo): Promise<void>;
  stopServer(): Promise<void>;
}

export interface CodexAppServerBackendDependencies {
  clientFactory?: (url: string) => CodexRpcClient;
  daemonManager?: CodexAppServerDaemonManager;
}

type SpawnCodexDaemonProcess = (args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

const DEFAULT_MODEL = 'gpt-5.3-codex';
const DEFAULT_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 15_000;
const PORT_POLL_INTERVAL_MS = 100;
const CLOSE_TIMEOUT_MS = 500;
const STATE_FILE_VERSION = 1;
const RESUME_NOT_FOUND_PATTERN = /no rollout found|thread not found/i;
const THREAD_READ_UNMATERIALIZED_PATTERN = /includeTurns is unavailable before first user message/i;
const THREAD_READ_NOT_FOUND_PATTERN = /thread not loaded|thread not found|no rollout found|unknown thread/i;
const APP_SERVER_URL_PATTERN = /ws:\/\/127\.0\.0\.1:(\d+)/i;

function defaultSpawnCodexDaemon(args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  return spawn('codex', args, options);
}

function getDaemonStateFilePath(): string {
  return path.join(os.homedir(), '.dev-sessions', 'codex-appserver.json');
}

function getDaemonLogFilePath(): string {
  return path.join(os.homedir(), '.dev-sessions', 'codex-appserver.log');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }

    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPortOpen(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({
          host: '127.0.0.1',
          port
        });

        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', (error) => {
          socket.destroy();
          reject(error);
        });
      });

      return;
    } catch {
      await sleep(PORT_POLL_INTERVAL_MS);
    }
  }

  throw new Error(`Timed out waiting for Codex app-server to listen on port ${port}`);
}

class DefaultCodexAppServerDaemonManager implements CodexAppServerDaemonManager {
  constructor(
    private readonly stateFilePath: string = getDaemonStateFilePath(),
    private readonly logFilePath: string = getDaemonLogFilePath(),
    private readonly spawnDaemonProcess: SpawnCodexDaemonProcess = defaultSpawnCodexDaemon
  ) {}

  async ensureServer(): Promise<CodexAppServerInfo> {
    const existing = await this.getServer();
    if (existing) {
      return existing;
    }

    return this.startServer();
  }

  async getServer(): Promise<CodexAppServerInfo | undefined> {
    const state = await this.readState();
    if (!state) {
      return undefined;
    }

    if (!isProcessRunning(state.pid)) {
      await this.deleteStateFile();
      return undefined;
    }

    return {
      pid: state.pid,
      port: state.port,
      url: state.url
    };
  }

  async isServerRunning(pid?: number, _port?: number): Promise<boolean> {
    if (typeof pid === 'number') {
      return isProcessRunning(pid);
    }

    return (await this.getServer()) !== undefined;
  }

  async resetServer(server?: CodexAppServerInfo): Promise<void> {
    const target = server ?? (await this.getServer());
    if (!target) {
      return;
    }

    try {
      process.kill(target.pid, 'SIGTERM');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }

    await this.deleteStateFile();
  }

  async stopServer(): Promise<void> {
    await this.resetServer();
  }

  private async startServer(): Promise<CodexAppServerInfo> {
    await mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const logHandle = await openFile(this.logFilePath, 'w');

    let child: ChildProcess | undefined;
    try {
      child = this.spawnDaemonProcess(['app-server', '--listen', 'ws://127.0.0.1:0'], {
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd]
      });
    } finally {
      await logHandle.close();
    }

    if (!child.pid || !Number.isInteger(child.pid)) {
      throw new Error('Failed to start Codex app-server (missing PID)');
    }

    child.unref();

    const port = await this.waitForListeningPort(child.pid);
    await waitForPortOpen(port, STARTUP_TIMEOUT_MS);

    const info: CodexAppServerInfo = {
      pid: child.pid,
      port,
      url: `ws://127.0.0.1:${port}`
    };

    await this.writeState(info);
    return info;
  }

  private async waitForListeningPort(pid: number): Promise<number> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (Date.now() <= deadline) {
      const logContents = await this.readLog();
      const match = logContents.match(APP_SERVER_URL_PATTERN);
      if (match) {
        const port = Number.parseInt(match[1], 10);
        if (Number.isInteger(port) && port > 0) {
          return port;
        }
      }

      if (!isProcessRunning(pid)) {
        throw new Error(`Codex app-server exited during startup. Log output:\n${logContents.trim()}`);
      }

      await sleep(PORT_POLL_INTERVAL_MS);
    }

    const finalLog = await this.readLog();
    throw new Error(`Timed out waiting for Codex app-server startup. Log output:\n${finalLog.trim()}`);
  }

  private async readLog(): Promise<string> {
    try {
      return await readFile(this.logFilePath, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }

      throw error;
    }
  }

  private async readState(): Promise<CodexAppServerStateFile | undefined> {
    try {
      const raw = await readFile(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CodexAppServerStateFile>;
      if (
        parsed.version !== STATE_FILE_VERSION ||
        !Number.isInteger(parsed.pid) ||
        !Number.isInteger(parsed.port) ||
        typeof parsed.url !== 'string'
      ) {
        return undefined;
      }

      return {
        version: STATE_FILE_VERSION,
        pid: parsed.pid as number,
        port: parsed.port as number,
        url: parsed.url,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date().toISOString()
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  private async writeState(info: CodexAppServerInfo): Promise<void> {
    await mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const tmpPath = `${this.stateFilePath}.tmp`;
    const payload: CodexAppServerStateFile = {
      version: STATE_FILE_VERSION,
      pid: info.pid,
      port: info.port,
      url: info.url,
      startedAt: new Date().toISOString()
    };

    await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmpPath, this.stateFilePath);
  }

  private async deleteStateFile(): Promise<void> {
    await rm(this.stateFilePath, { force: true });
  }
}

export class CodexWebSocketRpcClient implements CodexRpcClient {
  private ws?: WebSocket;
  private connectPromise?: Promise<void>;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private waiters: TurnWaiter[] = [];
  private currentText = '';
  private turnStatus?: TurnCompletionStatus;
  private turnError?: string;
  private turnThreadId?: string;
  private turnId?: string;
  private closed = false;
  private closing = false;

  constructor(private readonly url: string) {}

  get currentTurnText(): string {
    return this.currentText;
  }

  get lastTurnStatus(): TurnCompletionStatus | undefined {
    return this.turnStatus;
  }

  get lastTurnError(): string | undefined {
    return this.turnError;
  }

  async connectAndInitialize(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.connect();
    }

    await this.connectPromise;
    await this.request('initialize', {
      clientInfo: {
        name: 'dev-sessions',
        title: 'dev-sessions',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify('initialized', {});
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error(this.turnError ?? 'Codex app-server connection is closed');
    }

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server connection is not open');
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
        pending.reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

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

  async waitForTurnCompletion(
    timeoutMs: number,
    expectedThreadId?: string,
    expectedTurnId?: string
  ): Promise<CodexTurnWaitResult> {
    const cachedMatchesThread =
      !expectedThreadId || (typeof this.turnThreadId === 'string' && this.turnThreadId === expectedThreadId);
    const cachedMatchesTurn = !expectedTurnId || (typeof this.turnId === 'string' && this.turnId === expectedTurnId);
    const cachedMatchesExpected = cachedMatchesThread && cachedMatchesTurn;
    if (this.turnStatus && cachedMatchesExpected) {
      return {
        completed: true,
        timedOut: false,
        elapsedMs: 0,
        status: this.turnStatus,
        errorMessage: this.turnError
      };
    }

    const safeTimeout = Math.max(1, timeoutMs);

    return new Promise<CodexTurnWaitResult>((resolve) => {
      const startTime = Date.now();
      const timeoutHandle = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timeoutHandle !== timeoutHandle);
        this.turnStatus = 'interrupted';
        this.turnError = 'Timed out waiting for Codex turn completion';
        resolve({
          completed: false,
          timedOut: true,
          elapsedMs: Date.now() - startTime,
          status: 'interrupted',
          errorMessage: this.turnError
        });
      }, safeTimeout);

      this.waiters.push({
        startTime,
        timeoutHandle,
        expectedThreadId,
        expectedTurnId,
        resolve
      });
    });
  }

  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws || this.closed) {
      return;
    }

    this.closing = true;

    await new Promise<void>((resolve) => {
      const finish = () => {
        resolve();
      };

      const timeoutHandle = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // no-op
        }
        finish();
      }, CLOSE_TIMEOUT_MS);

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
  }

  private async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        perMessageDeflate: false,
        handshakeTimeout: REQUEST_TIMEOUT_MS
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
        const details = reason.toString().trim();
        const suffix = details.length > 0 ? `: ${details}` : '';
        reject(new Error(`Codex app-server websocket closed during connect (${code})${suffix}`));
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
      const text = typeof data === 'string' ? data : data.toString();
      this.handleMessageFrame(text);
    });

    ws.on('error', (error: Error) => {
      this.failConnection(`Codex app-server websocket error: ${error.message}`);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (this.closing) {
        this.closed = true;
        return;
      }

      const details = reason.toString().trim();
      const suffix = details.length > 0 ? `: ${details}` : '';
      this.failConnection(`Codex app-server websocket closed (${code})${suffix}`);
    });
  }

  private handleMessageFrame(frame: string): void {
    this.handleMaybeJsonLine(frame);
  }

  private handleMaybeJsonLine(rawLine: string): void {
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

    this.handleRpcMessage(payload);
  }

  private handleRpcMessage(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if ('id' in payload && typeof (payload as { id?: unknown }).id === 'number') {
      this.handleRpcResponse(payload as JsonRpcResponse);
      return;
    }

    if ('method' in payload && typeof (payload as { method?: unknown }).method === 'string') {
      this.handleNotification(payload as { method: string; params?: unknown });
    }
  }

  private handleRpcResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeoutHandle);

    if (response.error) {
      const message = response.error.message ?? 'Unknown JSON-RPC error';
      pending.reject(new Error(`${pending.method} failed: ${message}`));
      return;
    }

    pending.resolve(response.result);
  }

  private handleNotification(notification: { method: string; params?: unknown }): void {
    if (notification.method === 'item/agentMessage/delta') {
      const deltaText = extractDeltaText(notification.params);
      if (deltaText.length > 0) {
        this.currentText += deltaText;
      }
      return;
    }

    if (notification.method === 'turn/started') {
      const turn = (notification.params as { turn?: unknown } | undefined)?.turn;
      this.turnStatus = undefined;
      this.turnError = undefined;
      this.turnThreadId = extractNotificationThreadId(notification.params);
      this.turnId = extractTurnId(turn);
      this.currentText = '';
      return;
    }

    if (notification.method !== 'turn/completed') {
      return;
    }

    const turn = (notification.params as { turn?: unknown } | undefined)?.turn;
    const status = extractTurnStatus(turn);
    if (!status) {
      return;
    }

    const notificationThreadId = extractNotificationThreadId(notification.params);
    const notificationTurnId = extractTurnId(turn);
    if (this.waiters.length > 0 && !this.hasMatchingWaiterForTurn(notificationThreadId, notificationTurnId)) {
      return;
    }

    this.turnStatus = status;
    this.turnError = extractTurnError(turn);
    this.turnThreadId = notificationThreadId;
    this.turnId = notificationTurnId;
    this.resolveWaiters({
      completed: true,
      timedOut: false,
      elapsedMs: 0,
      status,
      errorMessage: this.turnError,
      assistantText: this.currentText.length > 0 ? this.currentText : undefined
    }, notificationThreadId, notificationTurnId);
  }

  private hasMatchingWaiterForTurn(threadId: string | undefined, turnId: string | undefined): boolean {
    return this.waiters.some((waiter) => {
      const threadMatches = !waiter.expectedThreadId || threadId === waiter.expectedThreadId;
      const turnMatches = !waiter.expectedTurnId || turnId === waiter.expectedTurnId;
      return threadMatches && turnMatches;
    });
  }

  private resolveWaiters(
    baseResult: CodexTurnWaitResult,
    completedThreadId?: string,
    completedTurnId?: string,
    forceAll: boolean = false
  ): void {
    const waiters = this.waiters;
    this.waiters = [];
    const now = Date.now();

    for (const waiter of waiters) {
      const threadMatches = !waiter.expectedThreadId || completedThreadId === waiter.expectedThreadId;
      const turnMatches = !waiter.expectedTurnId || completedTurnId === waiter.expectedTurnId;
      if (!forceAll && !(threadMatches && turnMatches)) {
        this.waiters.push(waiter);
        continue;
      }

      clearTimeout(waiter.timeoutHandle);
      waiter.resolve({
        ...baseResult,
        elapsedMs: now - waiter.startTime
      });
    }
  }

  private failConnection(message: string): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.turnStatus = this.turnStatus ?? 'failed';
    this.turnError = this.turnError ?? message;

    const pendingRequests = [...this.pendingRequests.values()];
    this.pendingRequests.clear();

    for (const pending of pendingRequests) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error(message));
    }

    this.resolveWaiters({
      completed: true,
      timedOut: false,
      elapsedMs: 0,
      status: this.turnStatus,
      errorMessage: this.turnError
    }, undefined, undefined, true);
  }

  private notify(method: string, params?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

function extractThreadId(result: unknown): string {
  const threadId = (result as { thread?: { id?: unknown } } | undefined)?.thread?.id;
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new Error('thread/start did not return a thread ID');
  }

  return threadId;
}

// Codex 0.104.0 shipped before ThreadStatus was added to the protocol and omits
// thread.status entirely for idle threads, so missing status must be treated as
// idle. Starting with the post-0.104.0 protocol (expected in 0.105.0 stable),
// ThreadStatus is a tagged serde enum and will appear as objects such as
// {"type":"idle"} / {"type":"active","activeFlags":[...]}. When 0.105.0 is
// supported here, update this parser to handle both shapes.
function extractThreadRuntimeStatus(result: unknown): 'active' | 'idle' | 'notLoaded' | 'systemError' | 'unknown' {
  const thread = (result as { thread?: Record<string, unknown> } | undefined)?.thread;
  if (!thread || !('status' in thread)) {
    return 'idle';
  }
  const status = thread.status;
  if (status === 'idle' || status === 'notLoaded' || status === 'systemError') {
    return status;
  }
  if (status !== null && typeof status === 'object' && 'active' in status) {
    return 'active';
  }
  return 'unknown';
}

function extractThreadReadAssistantMessages(result: unknown): string[] {
  if (!result || typeof result !== 'object') {
    throw new Error('thread/read returned an invalid response');
  }
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== 'object') {
    throw new Error('thread/read response is missing result.thread');
  }
  const turns = (thread as Record<string, unknown>).turns;
  if (!Array.isArray(turns)) {
    throw new Error('thread/read response is missing result.thread.turns');
  }
  const messages: string[] = [];
  for (const turn of turns as unknown[]) {
    if (!turn || typeof turn !== 'object') continue;
    const items = (turn as Record<string, unknown>).items;
    if (!Array.isArray(items)) continue;
    for (const item of items as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (rec.type === 'agentMessage' && typeof rec.text === 'string' && rec.text.length > 0) {
        messages.push(rec.text);
      }
    }
  }
  return messages;
}

function extractUserMessageText(item: Record<string, unknown>): string {
  if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const part of item.content as unknown[]) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        if (typeof p.text === 'string' && p.text.length > 0) {
          parts.push(p.text);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join('');
    }
  }
  if (typeof item.text === 'string') {
    return item.text;
  }
  return '';
}

function extractThreadTurns(result: unknown): Array<{ role: 'human' | 'assistant'; text: string }> {
  if (!result || typeof result !== 'object') {
    throw new Error('thread/read returned an invalid response');
  }
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== 'object') {
    throw new Error('thread/read response is missing result.thread');
  }
  const turns = (thread as Record<string, unknown>).turns;
  if (!Array.isArray(turns)) {
    throw new Error('thread/read response is missing result.thread.turns');
  }
  const sessionTurns: Array<{ role: 'human' | 'assistant'; text: string }> = [];
  for (const turn of turns as unknown[]) {
    if (!turn || typeof turn !== 'object') continue;
    const items = (turn as Record<string, unknown>).items;
    if (!Array.isArray(items)) continue;
    for (const item of items as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (rec.type === 'userMessage') {
        const text = extractUserMessageText(rec);
        if (text.length > 0) {
          sessionTurns.push({ role: 'human', text });
        }
      } else if (rec.type === 'agentMessage' && typeof rec.text === 'string' && rec.text.length > 0) {
        sessionTurns.push({ role: 'assistant', text: rec.text });
      }
    }
  }
  return sessionTurns;
}

function extractDeltaText(params: unknown): string {
  if (!params || typeof params !== 'object') {
    return '';
  }

  const delta = (params as Record<string, unknown>).delta;
  return typeof delta === 'string' ? delta : '';
}

function extractNotificationThreadId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }

  const rec = params as Record<string, unknown>;
  const threadId = rec.threadId ?? rec.thread_id;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined;
}

function extractTurnId(turn: unknown): string | undefined {
  if (!turn || typeof turn !== 'object') {
    return undefined;
  }

  const turnId = (turn as { id?: unknown }).id;
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : undefined;
}

function extractStartedTurnId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  return extractTurnId((result as { turn?: unknown }).turn);
}

function extractTurnStatus(turn: unknown): TurnCompletionStatus | undefined {
  if (!turn || typeof turn !== 'object') {
    return undefined;
  }

  const status = (turn as { status?: unknown }).status;
  if (status === 'completed' || status === 'failed' || status === 'interrupted') {
    return status;
  }

  return undefined;
}

function extractTurnError(turn: unknown): string | undefined {
  if (!turn || typeof turn !== 'object') {
    return undefined;
  }

  const error = (turn as { error?: unknown }).error;
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }

  return undefined;
}

export class CodexAppServerBackend {
  private readonly sessionState = new Map<string, SessionState>();
  private readonly daemonManager: CodexAppServerDaemonManager;
  private readonly clientFactory: (url: string) => CodexRpcClient;

  constructor(dependencies: CodexAppServerBackendDependencies = {}) {
    this.daemonManager = dependencies.daemonManager ?? new DefaultCodexAppServerDaemonManager();
    this.clientFactory = dependencies.clientFactory ?? ((url: string) => new CodexWebSocketRpcClient(url));
  }

  async createSession(
    championId: string,
    workspacePath: string,
    model: string = DEFAULT_MODEL
  ): Promise<CodexSessionCreateResult> {
    const { server, result } = await this.withConnectedClient(async (client) => {
      const threadResult = await client.request('thread/start', {
        model,
        cwd: workspacePath,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: false,
        persistExtendedHistory: true,
        experimentalRawEvents: false
      });

      return extractThreadId(threadResult);
    });

    this.ensureSessionState(championId);

    return {
      threadId: result,
      model,
      appServerPid: server.pid,
      appServerPort: server.port
    };
  }

  async sendMessage(
    championId: string,
    threadId: string,
    message: string,
    options?: CodexSendMessageOptions
  ): Promise<CodexSendResult> {
    if (!options || options.workspacePath.trim().length === 0) {
      throw new Error('Codex workspace path is required to send a message');
    }

    const model = options.model ?? DEFAULT_MODEL;
    this.ensureSessionState(championId);

    const { server, result: activeThreadId } = await this.withConnectedClient(async (client) => {
      let tid = threadId.trim();

      if (tid.length > 0) {
        try {
          await client.request('thread/resume', {
            threadId: tid,
            cwd: options.workspacePath,
            model,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            persistExtendedHistory: true
          });
        } catch (error: unknown) {
          if (!this.isResumeNotFoundError(error)) {
            throw error;
          }

          tid = '';
        }
      }

      if (tid.length === 0) {
        const threadResult = await client.request('thread/start', {
          model,
          cwd: options.workspacePath,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          ephemeral: false,
          persistExtendedHistory: true,
          experimentalRawEvents: false
        });
        tid = extractThreadId(threadResult);
      }

      const turnStartResult = await client.request('turn/start', {
        threadId: tid,
        input: [{ type: 'text', text: message }]
      });
      const startedTurnId = extractStartedTurnId(turnStartResult);

      // Best-effort: wait a short time for the turn to complete on this connection.
      // Captures fast responses (e.g. short answers) without blocking for long tasks.
      // Only use the result if the exact initiated turn actually completed — not
      // if it timed out or a different turn completed on the same thread.
      const FAST_CAPTURE_TIMEOUT_MS = 3_000;
      const earlyResult = await client.waitForTurnCompletion(FAST_CAPTURE_TIMEOUT_MS, tid, startedTurnId);
      const completedEarly = !earlyResult.timedOut && earlyResult.status === 'completed';
      return { tid, turnId: startedTurnId, assistantText: completedEarly ? earlyResult.assistantText : undefined };
    });

    const state = this.ensureSessionState(championId);
    if (activeThreadId.assistantText) {
      state.assistantHistory.push(activeThreadId.assistantText);
    }

    return {
      threadId: activeThreadId.tid,
      appServerPid: server.pid,
      appServerPort: server.port,
      turnId: activeThreadId.turnId,
      assistantText: activeThreadId.assistantText
    };
  }

  async getThreadRuntimeStatus(threadId: string): Promise<'active' | 'idle' | 'notLoaded' | 'systemError' | 'unknown'> {
    const normalizedThreadId = threadId.trim();
    if (normalizedThreadId.length === 0) {
      return 'unknown';
    }

    const { result } = await this.withConnectedClient(async (client) => {
      const resumeResult = await client.request('thread/resume', { threadId: normalizedThreadId });
      return extractThreadRuntimeStatus(resumeResult);
    });

    return result;
  }

  async waitForThread(
    championId: string,
    threadId: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    expectedTurnId?: string
  ): Promise<CodexTurnWaitResult> {
    const normalizedThreadId = threadId.trim();
    if (normalizedThreadId.length === 0) {
      return { completed: true, timedOut: false, elapsedMs: 0, status: 'completed' };
    }

    const normalizedExpectedTurnId = expectedTurnId?.trim() ?? '';
    const state = this.ensureSessionState(championId);
    const safeTimeoutMs = Math.max(1, timeoutMs);

    const overallStart = Date.now();
    let lastAssistantText: string | undefined;
    let sawActiveTurn = false;
    let result: CodexTurnWaitResult | undefined;

    if (normalizedExpectedTurnId.length > 0) {
      // Codex 0.104.0 can report thread/resume=idle and thread/read turn.status=completed
      // while the initiated turn is still running tools. When we know the exact turn ID
      // from turn/start, block on that turn's completion notification instead of trusting
      // thread runtime status.
      const waitCycle = await this.withConnectedClient(async (client) => {
        // Resume first so this connection is subscribed to notifications for the thread.
        await client.request('thread/resume', { threadId: normalizedThreadId });
        return client.waitForTurnCompletion(safeTimeoutMs, normalizedThreadId, normalizedExpectedTurnId);
      });

      if (waitCycle.result.assistantText) {
        lastAssistantText = waitCycle.result.assistantText;
      }

      result = {
        ...waitCycle.result,
        elapsedMs: waitCycle.result.timedOut
          ? Math.max(waitCycle.result.elapsedMs, Date.now() - overallStart)
          : waitCycle.result.elapsedMs,
        assistantText: waitCycle.result.assistantText ?? lastAssistantText
      };
    }

    while (!result) {
      const elapsedMs = Date.now() - overallStart;
      const remainingMs = safeTimeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        result = {
          completed: false,
          timedOut: true,
          elapsedMs: Math.max(1, elapsedMs),
          status: 'interrupted',
          errorMessage: 'Timed out waiting for Codex turn completion',
          assistantText: lastAssistantText
        };
        break;
      }

      const cycle = await this.withConnectedClient(async (client) => {
        const resumeResult = await client.request('thread/resume', { threadId: normalizedThreadId });
        const runtimeStatus = extractThreadRuntimeStatus(resumeResult);

        if (runtimeStatus === 'active') {
          const waitResult = await client.waitForTurnCompletion(remainingMs, normalizedThreadId);
          return { kind: 'wait' as const, waitResult };
        }

        if (runtimeStatus === 'systemError' || runtimeStatus === 'unknown') {
          return {
            kind: 'terminal' as const,
            waitResult: {
              completed: true,
              timedOut: false,
              elapsedMs: 0,
              status: 'failed' as const,
              errorMessage:
                runtimeStatus === 'systemError'
                  ? 'Codex thread is in systemError state'
                  : 'Unable to determine Codex thread runtime status'
            }
          };
        }

        return {
          kind: 'idle' as const,
          waitResult: { completed: true, timedOut: false, elapsedMs: 0, status: 'completed' as const }
        };
      });

      if (cycle.result.kind === 'wait') {
        sawActiveTurn = true;
        if (cycle.result.waitResult.assistantText) {
          lastAssistantText = cycle.result.waitResult.assistantText;
        }

        if (
          cycle.result.waitResult.timedOut ||
          cycle.result.waitResult.status === 'failed' ||
          cycle.result.waitResult.status === 'interrupted'
        ) {
          result = {
            ...cycle.result.waitResult,
            elapsedMs: Math.max(cycle.result.waitResult.elapsedMs, Date.now() - overallStart),
            assistantText: cycle.result.waitResult.assistantText ?? lastAssistantText
          };
          break;
        }

        // One turn completed, but the logical task may continue in a subsequent turn.
        // Reconnect and re-check thread runtime state until the thread is quiescent.
        continue;
      }

      const totalElapsedMs = Date.now() - overallStart;
      result = {
        ...cycle.result.waitResult,
        elapsedMs: sawActiveTurn ? Math.max(1, totalElapsedMs) : 0,
        assistantText: lastAssistantText
      };
    }

    state.lastTurnStatus = result.status;
    state.lastTurnError = result.errorMessage;
    if (result.assistantText) {
      state.assistantHistory.push(result.assistantText);
    }
    return result;
  }

  async waitForTurn(championId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<CodexTurnWaitResult> {
    const state = this.sessionState.get(championId);
    if (!state || !state.lastTurnStatus) {
      return {
        completed: true,
        timedOut: false,
        elapsedMs: 0,
        status: 'completed'
      };
    }

    if (state.lastTurnStatus === 'interrupted') {
      return {
        completed: false,
        timedOut: true,
        elapsedMs: Math.max(1, timeoutMs),
        status: 'interrupted',
        errorMessage: state.lastTurnError
      };
    }

    return {
      completed: true,
      timedOut: false,
      elapsedMs: 0,
      status: state.lastTurnStatus,
      errorMessage: state.lastTurnError
    };
  }

  async getLastAssistantMessages(championId: string, threadId: string, count: number): Promise<string[]> {
    const state = this.ensureSessionState(championId);
    const safeCount = Math.max(1, count);
    const normalizedThreadId = threadId.trim();

    if (normalizedThreadId.length === 0) {
      return state.assistantHistory.slice(-safeCount);
    }

    try {
      const { result } = await this.withConnectedClient(async (client) => {
        const readResult = await client.request('thread/read', {
          threadId: normalizedThreadId,
          includeTurns: true
        });
        return extractThreadReadAssistantMessages(readResult);
      });
      state.assistantHistory = result;
      return result.slice(-safeCount);
    } catch (error) {
      if (this.isThreadReadUnmaterializedError(error)) {
        return [];
      }
      throw error;
    }
  }

  async getThreadTurns(threadId: string): Promise<Array<{ role: 'human' | 'assistant'; text: string }>> {
    const normalizedThreadId = threadId.trim();
    if (normalizedThreadId.length === 0) {
      return [];
    }
    try {
      const { result } = await this.withConnectedClient(async (client) => {
        const readResult = await client.request('thread/read', {
          threadId: normalizedThreadId,
          includeTurns: true
        });
        return extractThreadTurns(readResult);
      });
      return result;
    } catch (error) {
      if (this.isThreadReadUnmaterializedError(error)) {
        return [];
      }
      throw error;
    }
  }

  getSessionStatus(championId: string): AgentTurnStatus {
    const state = this.ensureSessionState(championId);

    if (state.lastTurnStatus === 'failed') {
      const suffix = state.lastTurnError ? `: ${state.lastTurnError}` : '';
      throw new Error(`Codex turn failed${suffix}`);
    }

    if (state.lastTurnStatus === 'interrupted') {
      return 'working';
    }

    return 'idle';
  }

  async killSession(championId: string, pid?: number, threadId?: string, port?: number): Promise<void> {
    this.sessionState.delete(championId);

    if (!threadId || typeof port !== 'number') {
      return;
    }

    const activeServer = await this.daemonManager.getServer();
    if (!activeServer) {
      return;
    }

    if (typeof pid === 'number' && activeServer.pid !== pid) {
      return;
    }

    if (activeServer.port !== port) {
      return;
    }

    try {
      await this.withConnectedClientToServer(activeServer, async (client) => {
        await client.request('thread/archive', {
          threadId
        });
      });
    } catch (error: unknown) {
      if (
        !(
          error instanceof Error &&
          /not found|no rollout found|unknown thread|websocket|ECONNREFUSED|socket hang up|connection is not open/i
            .test(error.message)
        )
      ) {
        throw error;
      }
    }
  }

  async stopAppServer(): Promise<void> {
    await this.daemonManager.stopServer();
  }

  async sessionExists(_championId: string, pid?: number, port?: number, threadId?: string): Promise<boolean> {
    if (!threadId || threadId.trim().length === 0) {
      return this.daemonManager.isServerRunning(pid, port);
    }

    // Let transport errors propagate — callers that need tri-state liveness
    // should catch and treat as 'unknown' rather than 'dead'.
    const { result } = await this.withConnectedClient(async (client) => {
      return this.threadExistsOnServer(client, threadId.trim());
    });
    return result;
  }

  private async threadExistsOnServer(client: CodexRpcClient, threadId: string): Promise<boolean> {
    try {
      await client.request('thread/read', {
        threadId,
        includeTurns: false
      });
      return true;
    } catch (error: unknown) {
      if (this.isThreadReadNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  private ensureSessionState(championId: string): SessionState {
    const existing = this.sessionState.get(championId);
    if (existing) {
      return existing;
    }

    const created: SessionState = {
      assistantHistory: []
    };
    this.sessionState.set(championId, created);
    return created;
  }

  private async withConnectedClient<T>(
    fn: (client: CodexRpcClient) => Promise<T>
  ): Promise<{ server: CodexAppServerInfo; result: T }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const server = await this.daemonManager.ensureServer();

      try {
        const result = await this.withConnectedClientToServer(server, fn);
        return {
          server,
          result
        };
      } catch (error: unknown) {
        if (attempt === 0 && this.shouldResetDaemonAfterConnectionFailure(error)) {
          await this.daemonManager.resetServer(server);
          continue;
        }

        throw error;
      }
    }

    throw new Error('Unreachable');
  }

  private async withConnectedClientToServer<T>(
    server: CodexAppServerInfo,
    fn: (client: CodexRpcClient) => Promise<T>
  ): Promise<T> {
    const client = this.clientFactory(server.url);

    try {
      await client.connectAndInitialize();
      return await fn(client);
    } finally {
      await client.close().catch(() => {
        // Ignore close errors; the primary operation result/error is more useful.
      });
    }
  }

  private shouldResetDaemonAfterConnectionFailure(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return /websocket|ECONNREFUSED|EPIPE|socket hang up|closed during connect|connection is not open/i
      .test(error.message);
  }

  private isResumeNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return RESUME_NOT_FOUND_PATTERN.test(error.message);
  }

  private isThreadReadUnmaterializedError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return THREAD_READ_UNMATERIALIZED_PATTERN.test(error.message);
  }

  private isThreadReadNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return THREAD_READ_NOT_FOUND_PATTERN.test(error.message);
  }
}
