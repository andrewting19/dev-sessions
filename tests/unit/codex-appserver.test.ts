import { describe, expect, it } from 'vitest';
import {
  CodexAppServerBackend,
  CodexAppServerDaemonManager,
  CodexAppServerInfo,
  CodexRpcClient,
  CodexTurnWaitResult
} from '../../src/backends/codex-appserver';

interface RecordedRequest {
  method: string;
  params?: unknown;
}

interface FakeClientScript {
  onRequest?: (method: string, params: unknown, requestIndex: number) => unknown | Promise<unknown>;
  waitResult?: CodexTurnWaitResult;
  currentTurnText?: string;
  connectError?: Error;
}

class FakeRpcClient implements CodexRpcClient {
  readonly requests: RecordedRequest[] = [];
  connectCalls = 0;
  closeCalls = 0;
  currentTurnText = '';
  lastTurnStatus?: CodexTurnWaitResult['status'];
  lastTurnError?: string;

  constructor(private readonly script: FakeClientScript) {
    this.currentTurnText = script.currentTurnText ?? '';
    this.lastTurnStatus = script.waitResult?.status;
    this.lastTurnError = script.waitResult?.errorMessage;
  }

  async connectAndInitialize(): Promise<void> {
    this.connectCalls += 1;
    if (this.script.connectError) {
      throw this.script.connectError;
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    const response = await this.script.onRequest?.(method, params, this.requests.length - 1);
    return response;
  }

  async waitForTurnCompletion(_timeoutMs: number): Promise<CodexTurnWaitResult> {
    const result =
      this.script.waitResult ??
      ({
        completed: true,
        timedOut: false,
        elapsedMs: 10,
        status: 'completed'
      } satisfies CodexTurnWaitResult);

    this.lastTurnStatus = result.status;
    this.lastTurnError = result.errorMessage;
    return result;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeDaemonManager implements CodexAppServerDaemonManager {
  ensureCalls = 0;
  getServerCalls = 0;
  resetCalls: CodexAppServerInfo[] = [];
  stopCalls = 0;
  isRunningCalls: Array<{ pid?: number; port?: number }> = [];
  running = true;
  server: CodexAppServerInfo = {
    pid: 9001,
    port: 4510,
    url: 'ws://127.0.0.1:4510'
  };

  async ensureServer(): Promise<CodexAppServerInfo> {
    this.ensureCalls += 1;
    return this.server;
  }

  async getServer(): Promise<CodexAppServerInfo | undefined> {
    this.getServerCalls += 1;
    return this.running ? this.server : undefined;
  }

  async isServerRunning(pid?: number, port?: number): Promise<boolean> {
    this.isRunningCalls.push({ pid, port });
    return this.running;
  }

  async resetServer(server?: CodexAppServerInfo): Promise<void> {
    if (server) {
      this.resetCalls.push(server);
    }
    this.running = false;
  }

  async stopServer(): Promise<void> {
    this.stopCalls += 1;
    this.running = false;
  }
}

function createHarness(scripts: FakeClientScript[]): {
  backend: CodexAppServerBackend;
  daemon: FakeDaemonManager;
  clients: FakeRpcClient[];
} {
  const daemon = new FakeDaemonManager();
  const clients: FakeRpcClient[] = [];
  let scriptIndex = 0;

  const backend = new CodexAppServerBackend({
    daemonManager: daemon,
    clientFactory: () => {
      const script = scripts[scriptIndex] ?? {};
      scriptIndex += 1;
      const client = new FakeRpcClient(script);
      clients.push(client);
      return client;
    }
  });

  return {
    backend,
    daemon,
    clients
  };
}

describe('CodexAppServerBackend', () => {
  it('creates a thread through the shared daemon and returns daemon connection info', async () => {
    const { backend, daemon, clients } = createHarness([
      {
        onRequest: (method) => {
          if (method === 'thread/start') {
            return {
              thread: {
                id: 'thr_123'
              }
            };
          }

          return {};
        }
      }
    ]);

    const created = await backend.createSession('fizz-top', '/tmp/workspace', 'gpt-5.3-codex');

    expect(created).toEqual({
      threadId: 'thr_123',
      model: 'gpt-5.3-codex',
      appServerPid: daemon.server.pid,
      appServerPort: daemon.server.port
    });
    expect(daemon.ensureCalls).toBe(1);
    expect(clients).toHaveLength(1);
    expect(clients[0].connectCalls).toBe(1);
    expect(clients[0].closeCalls).toBe(1);
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/start']);
  });

  it('resumes a thread and accumulates the assistant message for session history', async () => {
    const { backend, clients } = createHarness([
      {
        onRequest: (method) => {
          if (method === 'thread/start') {
            return {
              thread: {
                id: 'thr_seed'
              }
            };
          }

          return {};
        }
      },
      {
        currentTurnText: 'Done here',
        waitResult: {
          completed: true,
          timedOut: false,
          elapsedMs: 42,
          status: 'completed'
        },
        onRequest: (method) => {
          if (method === 'thread/resume' || method === 'turn/start') {
            return {};
          }

          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const created = await backend.createSession('riven-jg', '/tmp/repo', 'gpt-5.3-codex');
    const sendResult = await backend.sendMessage('riven-jg', created.threadId, 'Write tests', {
      workspacePath: '/tmp/repo',
      model: 'gpt-5.3-codex'
    });

    expect(sendResult).toMatchObject({
      threadId: 'thr_seed',
      completed: true,
      timedOut: false,
      status: 'completed',
      assistantMessage: 'Done here'
    });
    expect(clients[1].requests.map((entry) => entry.method)).toEqual(['thread/resume', 'turn/start']);
    expect(backend.getLastAssistantMessages('riven-jg', 1)).toEqual(['Done here']);
    expect(backend.getSessionStatus('riven-jg')).toBe('idle');
  });

  it('falls back to thread/start when thread/resume reports a missing thread', async () => {
    const { backend, clients } = createHarness([
      {
        currentTurnText: '',
        waitResult: {
          completed: true,
          timedOut: false,
          elapsedMs: 21,
          status: 'completed'
        },
        onRequest: (method) => {
          if (method === 'thread/resume') {
            throw new Error('thread/resume failed: no rollout found for thread id stale-thread');
          }

          if (method === 'thread/start') {
            return {
              thread: {
                id: 'thr_fallback'
              }
            };
          }

          if (method === 'turn/start') {
            return {};
          }

          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const result = await backend.sendMessage('fizz-top', 'stale-thread', 'Ship this feature', {
      workspacePath: '/tmp/workspace',
      model: 'gpt-5.3-codex'
    });

    expect(result.threadId).toBe('thr_fallback');
    expect(result.status).toBe('completed');
    expect(clients[0].requests.map((entry) => entry.method)).toEqual([
      'thread/resume',
      'thread/start',
      'turn/start'
    ]);
  });

  it('captures failed turn completion and exposes failed status via helpers', async () => {
    const { backend } = createHarness([
      {
        waitResult: {
          completed: true,
          timedOut: false,
          elapsedMs: 8,
          status: 'failed',
          errorMessage: 'tool execution failed'
        },
        onRequest: (method) => {
          if (method === 'thread/start' || method === 'turn/start') {
            if (method === 'thread/start') {
              return {
                thread: {
                  id: 'thr_failed'
                }
              };
            }
            return {};
          }

          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const result = await backend.sendMessage('ahri-mid', '', 'Break intentionally', {
      workspacePath: '/tmp/repo'
    });

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('tool execution failed');
    expect(() => backend.getSessionStatus('ahri-mid')).toThrow('Codex turn failed: tool execution failed');

    const waitResult = await backend.waitForTurn('ahri-mid', 2_000);
    expect(waitResult).toMatchObject({
      completed: true,
      timedOut: false,
      status: 'failed',
      errorMessage: 'tool execution failed'
    });
  });

  it('returns timedOut when waitForTurnCompletion reports a timeout', async () => {
    const { backend } = createHarness([
      {
        waitResult: {
          completed: false,
          timedOut: true,
          elapsedMs: 25,
          status: 'interrupted',
          errorMessage: 'Timed out waiting for Codex turn completion'
        },
        onRequest: (method) => {
          if (method === 'thread/start') {
            return {
              thread: {
                id: 'thr_timeout'
              }
            };
          }

          if (method === 'turn/start') {
            return {};
          }

          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const sendResult = await backend.sendMessage('teemo-sup', '', 'This should time out', {
      workspacePath: '/tmp/repo',
      timeoutMs: 25
    });

    expect(sendResult).toMatchObject({
      completed: false,
      timedOut: true,
      status: 'interrupted'
    });
    expect(backend.getSessionStatus('teemo-sup')).toBe('working');
  });

  it('archives threads on kill and delegates shared daemon lifecycle checks', async () => {
    const { backend, daemon, clients } = createHarness([
      {
        onRequest: (method) => {
          if (method === 'thread/archive') {
            return {};
          }

          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    expect(await backend.sessionExists('fizz-top')).toBe(true);
    expect(await backend.sessionExists('fizz-top', daemon.server.pid, daemon.server.port)).toBe(true);

    await backend.killSession('fizz-top', daemon.server.pid, 'thr_to_archive', daemon.server.port);
    expect(daemon.getServerCalls).toBe(1);
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/archive']);

    await backend.stopAppServer();
    expect(daemon.stopCalls).toBe(1);
  });

  it('resets and retries when the first daemon connection fails', async () => {
    const { backend, daemon, clients } = createHarness([
      {
        connectError: new Error('socket hang up')
      },
      {
        onRequest: (method) => {
          if (method === 'thread/start') {
            return {
              thread: {
                id: 'thr_retry'
              }
            };
          }
          return {};
        }
      }
    ]);

    const created = await backend.createSession('fizz-top', '/tmp/workspace');

    expect(created.threadId).toBe('thr_retry');
    expect(daemon.resetCalls).toHaveLength(1);
    expect(clients).toHaveLength(2);
  });

  it('does not archive when the stored daemon PID/port no longer matches the active daemon', async () => {
    const { backend, daemon, clients } = createHarness([]);

    daemon.server = {
      pid: 9999,
      port: 5001,
      url: 'ws://127.0.0.1:5001'
    };

    await backend.killSession('fizz-top', 4321, 'thr_stale', 4510);

    expect(daemon.getServerCalls).toBe(1);
    expect(clients).toHaveLength(0);
  });

  it('ignores thread/archive not-found errors during kill', async () => {
    const { backend, daemon } = createHarness([
      {
        onRequest: (method) => {
          if (method === 'thread/archive') {
            throw new Error('thread/archive failed: thread not found');
          }
          return {};
        }
      }
    ]);

    await expect(
      backend.killSession('fizz-top', daemon.server.pid, 'thr_missing', daemon.server.port)
    ).resolves.toBeUndefined();
  });
});
