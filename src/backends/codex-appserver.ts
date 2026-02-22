import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
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
}

interface TurnWaiter {
  startTime: number;
  timeoutHandle: NodeJS.Timeout;
  resolve: (result: CodexTurnWaitResult) => void;
}

interface CodexSessionRuntime {
  process: ChildProcessWithoutNullStreams;
  nextRequestId: number;
  stdoutBuffer: string;
  pendingRequests: Map<number, PendingRequest>;
  turnInProgress: boolean;
  currentTurnText: string;
  assistantHistory: string[];
  waiters: TurnWaiter[];
  threadId?: string;
  model: string;
  workspacePath: string;
  lastTurnStatus?: TurnCompletionStatus;
  lastTurnError?: string;
  exited: boolean;
}

export interface CodexSessionCreateResult {
  threadId: string;
  pid: number;
  model: string;
}

export interface CodexTurnWaitResult {
  completed: boolean;
  timedOut: boolean;
  elapsedMs: number;
  status: TurnCompletionStatus;
  errorMessage?: string;
}

export type SpawnCodexProcess = () => ChildProcessWithoutNullStreams;

const DEFAULT_MODEL = 'o4-mini';
const DEFAULT_TIMEOUT_MS = 300_000;

function defaultSpawnCodexProcess(): ChildProcessWithoutNullStreams {
  return spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

export class CodexAppServerBackend {
  private readonly sessions = new Map<string, CodexSessionRuntime>();

  constructor(private readonly spawnProcess: SpawnCodexProcess = defaultSpawnCodexProcess) {}

  async createSession(
    championId: string,
    workspacePath: string,
    model: string = DEFAULT_MODEL
  ): Promise<CodexSessionCreateResult> {
    if (this.sessions.has(championId)) {
      throw new Error(`Codex session already exists: ${championId}`);
    }

    const runtime = this.startRuntime(championId, workspacePath, model);
    this.sessions.set(championId, runtime);

    try {
      await this.request(runtime, 'initialize', {
        clientInfo: {
          name: 'dev-sessions',
          title: 'dev-sessions',
          version: '0.1.0'
        },
        capabilities: {
          experimentalApi: true
        }
      });

      this.notify(runtime, 'initialized', {});

      const threadResult = await this.request(runtime, 'thread/start', {
        model,
        cwd: workspacePath,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access'
      });

      const threadId = this.extractThreadId(threadResult);
      runtime.threadId = threadId;

      return {
        threadId,
        pid: this.requirePid(runtime.process),
        model
      };
    } catch (error: unknown) {
      await this.killRuntime(runtime);
      this.sessions.delete(championId);
      throw error;
    }
  }

  async sendMessage(championId: string, threadId: string, message: string): Promise<void> {
    const runtime = this.requireRuntime(championId);
    this.ensureUsableRuntime(championId, runtime);

    if (runtime.threadId !== threadId) {
      throw new Error(`Thread mismatch for ${championId}`);
    }

    if (runtime.turnInProgress) {
      throw new Error(`A turn is already running for ${championId}`);
    }

    runtime.turnInProgress = true;
    runtime.currentTurnText = '';
    runtime.lastTurnStatus = undefined;
    runtime.lastTurnError = undefined;

    try {
      await this.request(runtime, 'turn/start', {
        threadId,
        input: [{ type: 'text', text: message }]
      });
    } catch (error: unknown) {
      runtime.turnInProgress = false;
      throw error;
    }
  }

  async waitForTurn(championId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<CodexTurnWaitResult> {
    const runtime = this.requireRuntime(championId);
    this.ensureUsableRuntime(championId, runtime);

    if (!runtime.turnInProgress) {
      const status = runtime.lastTurnStatus ?? 'completed';

      return {
        completed: true,
        timedOut: false,
        elapsedMs: 0,
        status,
        errorMessage: runtime.lastTurnError
      };
    }

    const safeTimeout = Math.max(1, timeoutMs);

    return new Promise<CodexTurnWaitResult>((resolve) => {
      const startTime = Date.now();
      const timeoutHandle = setTimeout(() => {
        runtime.waiters = runtime.waiters.filter((waiter) => waiter.timeoutHandle !== timeoutHandle);
        resolve({
          completed: false,
          timedOut: true,
          elapsedMs: Date.now() - startTime,
          status: 'interrupted'
        });
      }, safeTimeout);

      runtime.waiters.push({
        startTime,
        timeoutHandle,
        resolve
      });
    });
  }

  getLastAssistantMessages(championId: string, count: number): string[] {
    const runtime = this.requireRuntime(championId);
    const safeCount = Math.max(1, count);
    return runtime.assistantHistory.slice(-safeCount);
  }

  getSessionStatus(championId: string): AgentTurnStatus {
    const runtime = this.requireRuntime(championId);
    this.ensureUsableRuntime(championId, runtime);

    if (runtime.turnInProgress) {
      return 'working';
    }

    if (runtime.lastTurnStatus === 'failed') {
      const suffix = runtime.lastTurnError ? `: ${runtime.lastTurnError}` : '';
      throw new Error(`Codex turn failed${suffix}`);
    }

    return 'idle';
  }

  async killSession(championId: string, pid?: number): Promise<void> {
    const runtime = this.sessions.get(championId);
    if (runtime) {
      await this.killRuntime(runtime);
      this.sessions.delete(championId);
      return;
    }

    if (typeof pid === 'number') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
    }
  }

  async sessionExists(championId: string, pid?: number): Promise<boolean> {
    const runtime = this.sessions.get(championId);
    if (runtime) {
      const processPid = runtime.process.pid;
      return !runtime.exited && typeof processPid === 'number' && this.isProcessRunning(processPid);
    }

    return typeof pid === 'number' ? this.isProcessRunning(pid) : false;
  }

  private startRuntime(championId: string, workspacePath: string, model: string): CodexSessionRuntime {
    const child = this.spawnProcess();
    const runtime: CodexSessionRuntime = {
      process: child,
      nextRequestId: 1,
      stdoutBuffer: '',
      pendingRequests: new Map<number, PendingRequest>(),
      turnInProgress: false,
      currentTurnText: '',
      assistantHistory: [],
      waiters: [],
      model,
      workspacePath,
      exited: false
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => {
      this.handleStdoutData(championId, runtime, chunk.toString());
    });

    child.on('error', (error: Error) => {
      this.failRuntime(runtime, `Codex app-server error: ${error.message}`);
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      const exitDetails = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
      this.failRuntime(runtime, `Codex app-server exited (${exitDetails})`);
    });

    return runtime;
  }

  private handleStdoutData(championId: string, runtime: CodexSessionRuntime, chunk: string): void {
    runtime.stdoutBuffer += chunk;
    const lines = runtime.stdoutBuffer.split('\n');
    runtime.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        continue;
      }

      this.handleRpcMessage(championId, runtime, payload);
    }
  }

  private handleRpcMessage(championId: string, runtime: CodexSessionRuntime, payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if ('id' in payload && typeof (payload as { id?: unknown }).id === 'number') {
      this.handleRpcResponse(runtime, payload as JsonRpcResponse);
      return;
    }

    if ('method' in payload && typeof (payload as { method?: unknown }).method === 'string') {
      this.handleNotification(championId, runtime, payload as { method: string; params?: unknown });
    }
  }

  private handleRpcResponse(runtime: CodexSessionRuntime, response: JsonRpcResponse): void {
    const pending = runtime.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    runtime.pendingRequests.delete(response.id);

    if (response.error) {
      const message = response.error.message ?? 'Unknown JSON-RPC error';
      pending.reject(new Error(`${pending.method} failed: ${message}`));
      return;
    }

    pending.resolve(response.result);
  }

  private handleNotification(
    _championId: string,
    runtime: CodexSessionRuntime,
    notification: { method: string; params?: unknown }
  ): void {
    if (notification.method === 'turn/started') {
      runtime.turnInProgress = true;
      return;
    }

    if (notification.method === 'item/agentMessage/delta') {
      const deltaText = this.extractDeltaText(notification.params);
      if (deltaText.length > 0) {
        runtime.currentTurnText += deltaText;
      }
      return;
    }

    if (notification.method === 'turn/completed') {
      const turn = (notification.params as { turn?: unknown } | undefined)?.turn;
      const status = this.extractTurnStatus(turn);
      if (!status) {
        return;
      }

      runtime.turnInProgress = false;
      runtime.lastTurnStatus = status;
      runtime.lastTurnError = this.extractTurnError(turn);

      if (runtime.currentTurnText.length > 0) {
        runtime.assistantHistory.push(runtime.currentTurnText);
      }
      runtime.currentTurnText = '';

      this.resolveWaiters(runtime, {
        completed: true,
        timedOut: false,
        elapsedMs: 0,
        status,
        errorMessage: runtime.lastTurnError
      });
    }
  }

  private resolveWaiters(runtime: CodexSessionRuntime, baseResult: CodexTurnWaitResult): void {
    const waiters = runtime.waiters.splice(0, runtime.waiters.length);
    const now = Date.now();

    for (const waiter of waiters) {
      clearTimeout(waiter.timeoutHandle);
      waiter.resolve({
        ...baseResult,
        elapsedMs: now - waiter.startTime
      });
    }
  }

  private failRuntime(runtime: CodexSessionRuntime, message: string): void {
    if (runtime.exited) {
      return;
    }

    runtime.exited = true;
    runtime.turnInProgress = false;
    runtime.lastTurnStatus = 'failed';
    runtime.lastTurnError = message;

    const pendingRequests = [...runtime.pendingRequests.values()];
    runtime.pendingRequests.clear();

    for (const pending of pendingRequests) {
      pending.reject(new Error(message));
    }

    this.resolveWaiters(runtime, {
      completed: true,
      timedOut: false,
      elapsedMs: 0,
      status: 'failed',
      errorMessage: message
    });
  }

  private async request(runtime: CodexSessionRuntime, method: string, params?: unknown): Promise<unknown> {
    const id = runtime.nextRequestId;
    runtime.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      runtime.pendingRequests.set(id, {
        method,
        resolve,
        reject
      });

      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      runtime.process.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private notify(runtime: CodexSessionRuntime, method: string, params?: unknown): void {
    const payload = {
      jsonrpc: '2.0',
      method,
      params
    };

    runtime.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private extractThreadId(result: unknown): string {
    const threadId = (result as { thread?: { id?: unknown } } | undefined)?.thread?.id;
    if (typeof threadId !== 'string' || threadId.trim().length === 0) {
      throw new Error('thread/start did not return a thread ID');
    }

    return threadId;
  }

  private extractDeltaText(params: unknown): string {
    if (!params || typeof params !== 'object') {
      return '';
    }

    const asRecord = params as Record<string, unknown>;
    const directText = asRecord.text;
    if (typeof directText === 'string') {
      return directText;
    }

    const delta = asRecord.delta;
    if (delta && typeof delta === 'object' && typeof (delta as Record<string, unknown>).text === 'string') {
      return (delta as Record<string, string>).text;
    }

    const item = asRecord.item;
    if (item && typeof item === 'object') {
      const nestedDelta = (item as Record<string, unknown>).delta;
      if (
        nestedDelta &&
        typeof nestedDelta === 'object' &&
        typeof (nestedDelta as Record<string, unknown>).text === 'string'
      ) {
        return (nestedDelta as Record<string, string>).text;
      }
    }

    return '';
  }

  private extractTurnStatus(turn: unknown): TurnCompletionStatus | undefined {
    if (!turn || typeof turn !== 'object') {
      return undefined;
    }

    const status = (turn as { status?: unknown }).status;
    if (status === 'completed' || status === 'failed' || status === 'interrupted') {
      return status;
    }

    return undefined;
  }

  private extractTurnError(turn: unknown): string | undefined {
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

  private ensureUsableRuntime(championId: string, runtime: CodexSessionRuntime): void {
    if (runtime.exited) {
      const details = runtime.lastTurnError ? `: ${runtime.lastTurnError}` : '';
      throw new Error(`Codex app-server is not running for ${championId}${details}`);
    }
  }

  private requireRuntime(championId: string): CodexSessionRuntime {
    const runtime = this.sessions.get(championId);
    if (!runtime) {
      throw new Error(`Codex session not found in this process: ${championId}`);
    }

    return runtime;
  }

  private requirePid(processHandle: ChildProcessWithoutNullStreams): number {
    if (typeof processHandle.pid !== 'number') {
      throw new Error('Codex app-server PID is unavailable');
    }

    return processHandle.pid;
  }

  private async killRuntime(runtime: CodexSessionRuntime): Promise<void> {
    runtime.exited = true;

    const pendingRequests = [...runtime.pendingRequests.values()];
    runtime.pendingRequests.clear();
    for (const pending of pendingRequests) {
      pending.reject(new Error('Codex app-server terminated'));
    }

    this.resolveWaiters(runtime, {
      completed: true,
      timedOut: false,
      elapsedMs: 0,
      status: 'interrupted'
    });

    try {
      runtime.process.stdin.end();
    } catch {
      // no-op
    }

    if (runtime.process.exitCode === null && runtime.process.signalCode === null) {
      runtime.process.kill('SIGTERM');
    }
  }

  private isProcessRunning(pid: number): boolean {
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
}
