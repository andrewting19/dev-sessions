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
  timeoutHandle: NodeJS.Timeout;
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
  waiters: TurnWaiter[];
  currentTurnText: string;
  lastTurnStatus?: TurnCompletionStatus;
  lastTurnError?: string;
  exited: boolean;
}

interface SessionState {
  assistantHistory: string[];
  lastTurnStatus?: TurnCompletionStatus;
  lastTurnError?: string;
}

export interface CodexSessionCreateResult {
  threadId: string;
  model: string;
}

export interface CodexTurnWaitResult {
  completed: boolean;
  timedOut: boolean;
  elapsedMs: number;
  status: TurnCompletionStatus;
  errorMessage?: string;
}

export interface CodexSendMessageOptions {
  workspacePath: string;
  model?: string;
  timeoutMs?: number;
}

export interface CodexTurnSendResult extends CodexTurnWaitResult {
  threadId: string;
  assistantMessage: string;
}

export type SpawnCodexProcess = () => ChildProcessWithoutNullStreams;

const DEFAULT_MODEL = 'gpt-5.3-codex';
const DEFAULT_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 60_000;
const RESUME_NOT_FOUND_PATTERN = /no rollout found|thread not found/i;

function defaultSpawnCodexProcess(): ChildProcessWithoutNullStreams {
  return spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

export class CodexAppServerBackend {
  private readonly sessionState = new Map<string, SessionState>();

  constructor(private readonly spawnProcess: SpawnCodexProcess = defaultSpawnCodexProcess) {}

  async createSession(
    championId: string,
    workspacePath: string,
    model: string = DEFAULT_MODEL
  ): Promise<CodexSessionCreateResult> {
    const runtime = this.startRuntime();

    try {
      await this.initializeRuntime(runtime);
      const threadResult = await this.request(runtime, 'thread/start', {
        model,
        cwd: workspacePath,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: false,
        persistExtendedHistory: true,
        experimentalRawEvents: false
      });

      const threadId = this.extractThreadId(threadResult);
      this.ensureSessionState(championId);

      return {
        threadId,
        model
      };
    } finally {
      await this.killRuntime(runtime);
    }
  }

  async sendMessage(
    championId: string,
    threadId: string,
    message: string,
    options?: CodexSendMessageOptions
  ): Promise<CodexTurnSendResult> {
    if (!options || options.workspacePath.trim().length === 0) {
      throw new Error('Codex workspace path is required to send a message');
    }

    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const model = options.model ?? DEFAULT_MODEL;
    const runtime = this.startRuntime();
    const state = this.ensureSessionState(championId);

    let activeThreadId = threadId.trim();

    try {
      await this.initializeRuntime(runtime);

      if (activeThreadId.length > 0) {
        try {
          await this.request(runtime, 'thread/resume', {
            threadId: activeThreadId,
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

          activeThreadId = '';
        }
      }

      if (activeThreadId.length === 0) {
        const threadResult = await this.request(runtime, 'thread/start', {
          model,
          cwd: options.workspacePath,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          ephemeral: false,
          persistExtendedHistory: true,
          experimentalRawEvents: false
        });
        activeThreadId = this.extractThreadId(threadResult);
      }

      await this.request(runtime, 'turn/start', {
        threadId: activeThreadId,
        input: [{ type: 'text', text: message }]
      });

      const waitResult = await this.waitForTurnCompletion(runtime, timeoutMs);
      const assistantMessage = runtime.currentTurnText;

      state.lastTurnStatus = waitResult.status;
      state.lastTurnError = waitResult.errorMessage;

      if (assistantMessage.length > 0) {
        state.assistantHistory.push(assistantMessage);
      }

      return {
        ...waitResult,
        threadId: activeThreadId,
        assistantMessage
      };
    } finally {
      await this.killRuntime(runtime);
    }
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

  getLastAssistantMessages(championId: string, count: number): string[] {
    const state = this.ensureSessionState(championId);
    const safeCount = Math.max(1, count);
    return state.assistantHistory.slice(-safeCount);
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

  async killSession(championId: string, pid?: number): Promise<void> {
    this.sessionState.delete(championId);

    if (typeof pid !== 'number') {
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  }

  async sessionExists(_championId: string, pid?: number): Promise<boolean> {
    if (typeof pid !== 'number') {
      return true;
    }

    return this.isProcessRunning(pid);
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

  private startRuntime(): CodexSessionRuntime {
    const child = this.spawnProcess();
    const runtime: CodexSessionRuntime = {
      process: child,
      nextRequestId: 1,
      stdoutBuffer: '',
      pendingRequests: new Map<number, PendingRequest>(),
      waiters: [],
      currentTurnText: '',
      exited: false
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => {
      this.handleStdoutData(runtime, chunk.toString());
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

  private async initializeRuntime(runtime: CodexSessionRuntime): Promise<void> {
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
  }

  private handleStdoutData(runtime: CodexSessionRuntime, chunk: string): void {
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

      this.handleRpcMessage(runtime, payload);
    }
  }

  private handleRpcMessage(runtime: CodexSessionRuntime, payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if ('id' in payload && typeof (payload as { id?: unknown }).id === 'number') {
      this.handleRpcResponse(runtime, payload as JsonRpcResponse);
      return;
    }

    if ('method' in payload && typeof (payload as { method?: unknown }).method === 'string') {
      this.handleNotification(runtime, payload as { method: string; params?: unknown });
    }
  }

  private handleRpcResponse(runtime: CodexSessionRuntime, response: JsonRpcResponse): void {
    const pending = runtime.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    runtime.pendingRequests.delete(response.id);
    clearTimeout(pending.timeoutHandle);

    if (response.error) {
      const message = response.error.message ?? 'Unknown JSON-RPC error';
      pending.reject(new Error(`${pending.method} failed: ${message}`));
      return;
    }

    pending.resolve(response.result);
  }

  private handleNotification(runtime: CodexSessionRuntime, notification: { method: string; params?: unknown }): void {
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

      runtime.lastTurnStatus = status;
      runtime.lastTurnError = this.extractTurnError(turn);
      this.resolveWaiters(runtime, {
        completed: true,
        timedOut: false,
        elapsedMs: 0,
        status,
        errorMessage: runtime.lastTurnError
      });
    }
  }

  private async waitForTurnCompletion(runtime: CodexSessionRuntime, timeoutMs: number): Promise<CodexTurnWaitResult> {
    if (runtime.lastTurnStatus) {
      return {
        completed: true,
        timedOut: false,
        elapsedMs: 0,
        status: runtime.lastTurnStatus,
        errorMessage: runtime.lastTurnError
      };
    }

    const safeTimeout = Math.max(1, timeoutMs);

    return new Promise<CodexTurnWaitResult>((resolve) => {
      const startTime = Date.now();
      const timeoutHandle = setTimeout(() => {
        runtime.waiters = runtime.waiters.filter((waiter) => waiter.timeoutHandle !== timeoutHandle);
        runtime.lastTurnStatus = 'interrupted';
        runtime.lastTurnError = 'Timed out waiting for Codex turn completion';
        resolve({
          completed: false,
          timedOut: true,
          elapsedMs: Date.now() - startTime,
          status: 'interrupted',
          errorMessage: runtime.lastTurnError
        });
      }, safeTimeout);

      runtime.waiters.push({
        startTime,
        timeoutHandle,
        resolve
      });
    });
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
    runtime.lastTurnStatus = 'failed';
    runtime.lastTurnError = message;

    const pendingRequests = [...runtime.pendingRequests.values()];
    runtime.pendingRequests.clear();

    for (const pending of pendingRequests) {
      clearTimeout(pending.timeoutHandle);
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
    if (runtime.exited) {
      const message = runtime.lastTurnError ?? 'Codex app-server exited';
      throw new Error(message);
    }

    const id = runtime.nextRequestId;
    runtime.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const pending = runtime.pendingRequests.get(id);
        if (!pending) {
          return;
        }
        runtime.pendingRequests.delete(id);
        pending.reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      runtime.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timeoutHandle
      });

      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      try {
        runtime.process.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error: unknown) {
        runtime.pendingRequests.delete(id);
        clearTimeout(timeoutHandle);
        reject(error as Error);
      }
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

  private isResumeNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return RESUME_NOT_FOUND_PATTERN.test(error.message);
  }

  private async killRuntime(runtime: CodexSessionRuntime): Promise<void> {
    const pendingRequests = [...runtime.pendingRequests.values()];
    runtime.pendingRequests.clear();

    for (const pending of pendingRequests) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('Codex app-server terminated'));
    }

    this.resolveWaiters(runtime, {
      completed: true,
      timedOut: false,
      elapsedMs: 0,
      status: runtime.lastTurnStatus ?? 'interrupted',
      errorMessage: runtime.lastTurnError
    });

    runtime.exited = true;

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
