import { randomBytes, randomUUID } from 'node:crypto';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, open as openFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import pkg from '../../package.json';
import { SessionTurn, WaitResult } from '../types';

const REQUEST_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 20_000;
const STARTUP_POLL_MS = 100;
const SEND_ACCEPT_TIMEOUT_MS = 15_000;
const STATE_FILE_VERSION = 1;

export type GrokSessionActivity = 'working' | 'idle' | 'needs_input' | 'dormant' | 'completed' | 'dead';

interface GrokAppServerStateFile {
  version: number;
  pid: number;
  port: number;
  url: string;
  secret: string;
  startedAt: string;
}

export interface GrokAppServerInfo {
  pid: number;
  port: number;
  url: string;
  secret: string;
}

export interface GrokSessionCreateResult {
  sessionId: string;
  model?: string;
  appServerPid: number;
  appServerPort: number;
}

export interface GrokSendResult {
  promptId: string;
  appServerPid: number;
  appServerPort: number;
}

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface GrokRosterEntry {
  sessionId: string;
  modelId?: string;
  activity: GrokSessionActivity;
}

interface GrokTurnTerminal {
  promptId?: string;
  stopReason?: string;
  agentResult?: string;
}

export interface GrokAcpClientLike {
  connectAndInitialize(): Promise<void>;
  readonly defaultModel?: string;
  createSession(workspacePath: string, model?: string): Promise<string>;
  loadSession(sessionId: string, workspacePath: string): Promise<void>;
  startPrompt(sessionId: string, message: string, promptId: string): Promise<void>;
  listRoster(): Promise<GrokRosterEntry[]>;
  getTurns(): SessionTurn[];
  getTerminal(promptId: string): GrokTurnTerminal | undefined;
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface GrokAppServerDaemonManager {
  ensureServer(): Promise<GrokAppServerInfo>;
  getServer(): Promise<GrokAppServerInfo | undefined>;
  stopServer(): Promise<void>;
}

export interface GrokAppServerBackendDependencies {
  daemonManager?: GrokAppServerDaemonManager;
  clientFactory?: (server: GrokAppServerInfo) => GrokAcpClientLike;
}

type SpawnGrokDaemonProcess = (args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isPortOpen(port: number): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', (error) => {
        socket.destroy();
        reject(error);
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port for Grok Build'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function defaultGrokBinary(): string {
  const managed = path.join(os.homedir(), '.grok', 'bin', 'grok');
  return existsSync(managed) ? managed : 'grok';
}

function defaultSpawnGrokDaemon(args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  return spawn(defaultGrokBinary(), args, options);
}

function defaultStateFilePath(): string {
  return path.join(os.homedir(), '.dev-sessions', 'grok-appserver.json');
}

function defaultLogFilePath(): string {
  return path.join(os.homedir(), '.dev-sessions', 'grok-appserver.log');
}

export class DefaultGrokAppServerDaemonManager implements GrokAppServerDaemonManager {
  constructor(
    private readonly stateFilePath: string = defaultStateFilePath(),
    private readonly logFilePath: string = defaultLogFilePath(),
    private readonly spawnDaemonProcess: SpawnGrokDaemonProcess = defaultSpawnGrokDaemon,
    private readonly startupTimeoutMs: number = STARTUP_TIMEOUT_MS
  ) {}

  async ensureServer(): Promise<GrokAppServerInfo> {
    const current = await this.getServer();
    if (current) {
      return current;
    }

    await this.acquireStartupLock();
    try {
      const startedElsewhere = await this.getServer();
      if (startedElsewhere) {
        return startedElsewhere;
      }
      return await this.startServer();
    } finally {
      await rm(this.startupLockPath, { recursive: true, force: true });
    }
  }

  async getServer(): Promise<GrokAppServerInfo | undefined> {
    const state = await this.readState();
    if (!state) {
      return undefined;
    }
    if (!isProcessRunning(state.pid)) {
      await rm(this.stateFilePath, { force: true });
      return undefined;
    }
    if (!(await isPortOpen(state.port))) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
      await rm(this.stateFilePath, { force: true });
      return undefined;
    }
    return { pid: state.pid, port: state.port, url: state.url, secret: state.secret };
  }

  async stopServer(): Promise<void> {
    const state = await this.readState();
    if (state && isProcessRunning(state.pid)) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
    }
    await rm(this.stateFilePath, { force: true });
  }

  private get startupLockPath(): string {
    return `${this.stateFilePath}.startup.lock`;
  }

  private async acquireStartupLock(): Promise<void> {
    await mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const deadline = Date.now() + this.startupTimeoutMs + 5_000;
    const staleMs = this.startupTimeoutMs + 15_000;
    while (true) {
      try {
        await mkdir(this.startupLockPath);
        return;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
      try {
        const lockStat = await stat(this.startupLockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          await rm(this.startupLockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Grok Build startup lock at ${this.startupLockPath}`);
      }
      await sleep(STARTUP_POLL_MS);
    }
  }

  private async startServer(): Promise<GrokAppServerInfo> {
    await mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const port = await reserveLoopbackPort();
    const secret = randomBytes(32).toString('hex');
    const logHandle = await openFile(this.logFilePath, 'w', 0o600);
    await chmod(this.logFilePath, 0o600);
    let child: ChildProcess | undefined;
    try {
      child = this.spawnDaemonProcess(
        ['agent', '--always-approve', 'serve', '--bind', `127.0.0.1:${port}`],
        {
          detached: true,
          stdio: ['ignore', logHandle.fd, logHandle.fd],
          env: { ...process.env, GROK_AGENT_SECRET: secret }
        }
      );
    } finally {
      await logHandle.close();
    }
    child.on('error', () => {
      // Startup readiness below reports a scoped error. Without this listener,
      // a missing executable would also become an uncaught EventEmitter error.
    });

    if (!child.pid) {
      throw new Error(
        `Failed to start Grok Build agent server. Install or update Grok Build, then run 'grok login'.`
      );
    }
    child.unref();

    try {
      const deadline = Date.now() + this.startupTimeoutMs;
      while (Date.now() <= deadline) {
        if (await isPortOpen(port)) {
          break;
        }
        if (!isProcessRunning(child.pid)) {
          const log = (await readFile(this.logFilePath, 'utf8').catch(() => ''))
            .replaceAll(secret, '[redacted]')
            .trim()
            .slice(-2_000);
          throw new Error(
            `Grok Build agent server exited during startup${log ? `: ${log}` : ''}. ` +
            `Install or update Grok Build, then run 'grok login'.`
          );
        }
        await sleep(STARTUP_POLL_MS);
      }
      if (!(await isPortOpen(port))) {
        throw new Error(`Timed out waiting for Grok Build agent server to listen on port ${port}`);
      }
    } catch (error) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {}
      throw error;
    }

    const state: GrokAppServerStateFile = {
      version: STATE_FILE_VERSION,
      pid: child.pid,
      port,
      url: `ws://127.0.0.1:${port}/ws`,
      secret,
      startedAt: new Date().toISOString()
    };
    const temporaryPath = `${this.stateFilePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.stateFilePath);
    return { pid: state.pid, port: state.port, url: state.url, secret: state.secret };
  }

  private async readState(): Promise<GrokAppServerStateFile | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFilePath, 'utf8')) as GrokAppServerStateFile;
      if (
        parsed.version !== STATE_FILE_VERSION ||
        !Number.isInteger(parsed.pid) ||
        !Number.isInteger(parsed.port) ||
        typeof parsed.url !== 'string' ||
        typeof parsed.secret !== 'string'
      ) {
        await rm(this.stateFilePath, { force: true });
        return undefined;
      }
      return parsed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        await rm(this.stateFilePath, { force: true });
        return undefined;
      }
      throw error;
    }
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value) => typeof value === 'string') as string | undefined;
}

function unwrapExtensionResult(value: unknown): unknown {
  const object = objectValue(value);
  return object && 'result' in object ? object.result : value;
}

export class GrokAcpClient implements GrokAcpClientLike {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly turns: SessionTurn[] = [];
  private readonly terminals = new Map<string, GrokTurnTerminal>();
  private readonly seenPromptIds = new Set<string>();
  private initialized = false;
  defaultModel?: string;

  constructor(private readonly server: GrokAppServerInfo) {}

  async connectAndInitialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const socket = new WebSocket(this.server.url, {
      headers: { Authorization: `Bearer ${this.server.secret}` }
    });
    this.socket = socket;
    socket.on('message', (data) => this.handleMessage(data.toString()));
    socket.on('close', () => this.failPending(new Error('Grok Build agent server connection closed')));
    socket.on('error', (error) => this.failPending(error));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const initializeResult = objectValue(await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      _meta: {
        startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true },
        clientType: 'dev-sessions',
        clientVersion: pkg.version
      }
    }));
    const meta = objectValue(initializeResult?._meta);
    const modelState = objectValue(meta?.modelState);
    this.defaultModel = stringValue(modelState?.currentModelId);

    const authMethods = Array.isArray(initializeResult?.authMethods)
      ? initializeResult.authMethods.map(objectValue).filter((entry): entry is Record<string, unknown> => entry !== undefined)
      : [];
    const advertisedIds = authMethods.map((entry) => stringValue(entry.id)).filter((id): id is string => id !== undefined);
    const preferred = stringValue(meta?.defaultAuthMethodId);
    const methodId = preferred && advertisedIds.includes(preferred)
      ? preferred
      : advertisedIds.includes('cached_token')
        ? 'cached_token'
        : advertisedIds.includes('xai.api_key')
          ? 'xai.api_key'
          : advertisedIds[0];
    if (methodId) {
      try {
        await this.request('authenticate', { methodId, _meta: { headless: true } });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Grok Build authentication failed: ${detail}. Run 'grok login' and try again.`);
      }
    }
    this.initialized = true;
  }

  async createSession(workspacePath: string, model?: string): Promise<string> {
    const meta: Record<string, unknown> = { yoloMode: true };
    if (model) {
      meta.modelId = model;
    }
    const result = objectValue(await this.request('session/new', {
      cwd: workspacePath,
      mcpServers: [],
      _meta: meta
    }));
    const sessionId = stringValue(result?.sessionId);
    if (!sessionId) {
      throw new Error('Grok Build session/new did not return a sessionId');
    }
    return sessionId;
  }

  async loadSession(sessionId: string, workspacePath: string): Promise<void> {
    await this.request('session/load', { sessionId, cwd: workspacePath, mcpServers: [] });
  }

  async startPrompt(sessionId: string, message: string, promptId: string): Promise<void> {
    const initialActivity = (await this.listRoster()).find((entry) => entry.sessionId === sessionId)?.activity;
    let settled = false;
    let failure: Error | undefined;
    const promptRequest = this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: message }],
      _meta: { promptId }
    });
    void promptRequest.then(
      () => { settled = true; },
      (error: unknown) => {
        settled = true;
        failure = error instanceof Error ? error : new Error(String(error));
      }
    );

    const deadline = Date.now() + SEND_ACCEPT_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      if (failure) {
        throw failure;
      }
      if (this.seenPromptIds.has(promptId) || settled) {
        return;
      }
      if (initialActivity !== 'working') {
        const live = (await this.listRoster()).find((entry) => entry.sessionId === sessionId);
        if (live?.activity === 'working' || live?.activity === 'needs_input') {
          return;
        }
      }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for Grok Build to accept prompt ${promptId}`);
  }

  async listRoster(): Promise<GrokRosterEntry[]> {
    const extension = unwrapExtensionResult(await this.request('_x.ai/sessions/list', {}));
    const response = objectValue(extension);
    const sessions = response?.sessions;
    if (!Array.isArray(sessions)) {
      throw new Error('Grok Build x.ai/sessions/list returned an invalid response');
    }
    return sessions.map(objectValue).filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map((entry) => ({
        sessionId: stringValue(entry.sessionId) ?? '',
        modelId: stringValue(entry.modelId),
        activity: (stringValue(entry.activity) ?? 'dead') as GrokSessionActivity
      }))
      .filter((entry) => entry.sessionId.length > 0);
  }

  getTurns(): SessionTurn[] {
    return this.turns.map((turn) => ({ ...turn }));
  }

  getTerminal(promptId: string): GrokTurnTerminal | undefined {
    const terminal = this.terminals.get(promptId);
    return terminal ? { ...terminal } : undefined;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request('_x.ai/session/close', { sessionId });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.initialized = false;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Grok Build agent server is not connected'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok Build request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleReverseRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        const data = typeof message.error.data === 'string' ? `: ${message.error.data}` : '';
        pending.reject(new Error(`${message.error.message ?? 'Grok Build request failed'}${data}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      this.captureNotification(message.method, message.params);
    }
  }

  private handleReverseRequest(message: JsonRpcMessage): void {
    const socket = this.socket;
    if (!socket || message.id === undefined) {
      return;
    }
    if (/request_permission|requestPermission/i.test(message.method ?? '')) {
      const params = objectValue(message.params);
      const options = Array.isArray(params?.options)
        ? params.options.map(objectValue).filter((option): option is Record<string, unknown> => option !== undefined)
        : [];
      const selected = options.find((option) => /allow.once|allow_once/i.test(stringValue(option.kind) ?? '')) ?? options[0];
      const optionId = stringValue(selected?.optionId, selected?.option_id);
      const outcome = optionId
        ? { outcome: 'selected', optionId }
        : { outcome: 'cancelled' };
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome } }));
      return;
    }
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Unsupported client method: ${message.method}` }
    }));
  }

  private captureNotification(method: string, paramsValue: unknown): void {
    const params = objectValue(paramsValue);
    if (!params) {
      return;
    }

    this.capturePromptIds(params);
    if (/prompt_complete$/i.test(method)) {
      const promptId = stringValue(params.promptId, params.prompt_id);
      if (promptId) {
        this.terminals.set(promptId, {
          promptId,
          stopReason: stringValue(params.stopReason, params.stop_reason),
          agentResult: stringValue(params.agentResult, params.agent_result)
        });
      }
      return;
    }

    if (!/session[\/_](update|notification)$/i.test(method)) {
      return;
    }
    const update = objectValue(params.update);
    if (!update) {
      return;
    }
    const kind = stringValue(update.sessionUpdate, update.session_update, update.type) ?? '';
    if (kind === 'turn_completed' || kind === 'turnCompleted') {
      const promptId = stringValue(update.promptId, update.prompt_id);
      if (promptId) {
        this.terminals.set(promptId, {
          promptId,
          stopReason: stringValue(update.stopReason, update.stop_reason),
          agentResult: stringValue(update.agentResult, update.agent_result)
        });
      }
      return;
    }
    const content = objectValue(update.content);
    const text = stringValue(content?.text);
    if (!text) {
      return;
    }
    if (kind === 'agent_message_chunk' || kind === 'agentMessageChunk') {
      this.appendTurn('assistant', text);
    } else if (kind === 'user_message_chunk' || kind === 'userMessageChunk') {
      this.appendTurn('human', text);
    }
  }

  private capturePromptIds(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.capturePromptIds(item);
      }
      return;
    }
    const object = objectValue(value);
    if (!object) {
      return;
    }
    for (const [key, child] of Object.entries(object)) {
      if (/^(promptId|prompt_id|runningPromptId|running_prompt_id|id)$/.test(key) && typeof child === 'string') {
        this.seenPromptIds.add(child);
      }
      if (typeof child === 'object' && child !== null) {
        this.capturePromptIds(child);
      }
    }
  }

  private appendTurn(role: SessionTurn['role'], text: string): void {
    const last = this.turns.at(-1);
    if (last?.role === role) {
      last.text += text;
    } else {
      this.turns.push({ role, text });
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class GrokAppServerBackend {
  private readonly daemonManager: GrokAppServerDaemonManager;
  private readonly clientFactory: (server: GrokAppServerInfo) => GrokAcpClientLike;

  constructor(dependencies: GrokAppServerBackendDependencies = {}) {
    this.daemonManager = dependencies.daemonManager ?? new DefaultGrokAppServerDaemonManager();
    this.clientFactory = dependencies.clientFactory ?? ((server) => new GrokAcpClient(server));
  }

  async createSession(workspacePath: string, model?: string): Promise<GrokSessionCreateResult> {
    const { server, client } = await this.connect();
    try {
      const sessionId = await client.createSession(workspacePath, model);
      return {
        sessionId,
        model: model ?? client.defaultModel,
        appServerPid: server.pid,
        appServerPort: server.port
      };
    } finally {
      await client.close();
    }
  }

  async sendMessage(sessionId: string, workspacePath: string, message: string): Promise<GrokSendResult> {
    const { server, client } = await this.connect();
    try {
      await client.loadSession(sessionId, workspacePath);
      const promptId = randomUUID();
      await client.startPrompt(sessionId, message, promptId);
      return { promptId, appServerPid: server.pid, appServerPort: server.port };
    } finally {
      await client.close();
    }
  }

  async getSessionActivity(sessionId: string): Promise<GrokSessionActivity> {
    const { client } = await this.connect();
    try {
      const entry = (await client.listRoster()).find((candidate) => candidate.sessionId === sessionId);
      if (!entry) {
        throw new Error(`Grok Build session not found: ${sessionId}`);
      }
      return entry.activity;
    } finally {
      await client.close();
    }
  }

  async waitForSession(
    sessionId: string,
    workspacePath: string,
    promptId: string | undefined,
    timeoutMs: number,
    intervalMs: number
  ): Promise<WaitResult> {
    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    const { client } = await this.connect();
    try {
      await client.loadSession(sessionId, workspacePath);
      let idleSamples = 0;
      while (Date.now() <= deadline) {
        if (promptId) {
          const terminal = client.getTerminal(promptId);
          if (terminal) {
            if (terminal.stopReason === 'error') {
              throw new Error(`Grok Build turn failed${terminal.agentResult ? `: ${terminal.agentResult}` : ''}`);
            }
            return { completed: true, timedOut: false, elapsedMs: Date.now() - startTime };
          }
        }

        const entry = (await client.listRoster()).find((candidate) => candidate.sessionId === sessionId);
        if (!entry) {
          throw new Error(`Grok Build session not found: ${sessionId}`);
        }
        if (entry.activity === 'dead') {
          throw new Error(`Grok Build session ${sessionId} is in a dead state`);
        }
        if (entry.activity === 'idle' || entry.activity === 'dormant' || entry.activity === 'completed') {
          if (!promptId) {
            return { completed: true, timedOut: false, elapsedMs: Date.now() - startTime };
          }
          idleSamples += 1;
          if (idleSamples >= 2) {
            // Current Grok releases persist an exact turn_completed event. The
            // idle fallback keeps compatibility with older ACP servers that do
            // not replay that extension, while two samples avoid a handoff race.
            return { completed: true, timedOut: false, elapsedMs: Date.now() - startTime };
          }
        } else {
          idleSamples = 0;
        }
        await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
      }
      return { completed: false, timedOut: true, elapsedMs: Date.now() - startTime };
    } finally {
      await client.close();
    }
  }

  async getLogs(sessionId: string, workspacePath: string): Promise<SessionTurn[]> {
    const { client } = await this.connect();
    try {
      await client.loadSession(sessionId, workspacePath);
      return client.getTurns();
    } finally {
      await client.close();
    }
  }

  async getLastMessages(sessionId: string, workspacePath: string, count: number): Promise<string[]> {
    const turns = await this.getLogs(sessionId, workspacePath);
    return turns
      .filter((turn) => turn.role === 'assistant' && turn.text.length > 0)
      .map((turn) => turn.text)
      .slice(-Math.max(1, count));
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    const { client } = await this.connect();
    try {
      return (await client.listRoster()).some((candidate) => candidate.sessionId === sessionId);
    } finally {
      await client.close();
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const { client } = await this.connect();
    try {
      await client.closeSession(sessionId);
    } finally {
      await client.close();
    }
  }

  async stopAppServer(): Promise<void> {
    await this.daemonManager.stopServer();
  }

  private async connect(): Promise<{ server: GrokAppServerInfo; client: GrokAcpClientLike }> {
    const server = await this.daemonManager.ensureServer();
    const client = this.clientFactory(server);
    try {
      await client.connectAndInitialize();
      return { server, client };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
}
