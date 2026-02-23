import { describe, expect, it } from 'vitest';
import {
  CodexAppServerBackend,
  CodexAppServerDaemonManager,
  CodexAppServerInfo,
  CodexRpcClient,
  CodexWebSocketRpcClient,
  CodexTurnWaitResult
} from '../../src/backends/codex-appserver';

interface RecordedRequest {
  method: string;
  params?: unknown;
}

interface FakeClientScript {
  onRequest?: (method: string, params: unknown, requestIndex: number) => unknown | Promise<unknown>;
  waitResult?: CodexTurnWaitResult;
  waitResults?: CodexTurnWaitResult[];
  currentTurnText?: string;
  connectError?: Error;
}

class FakeRpcClient implements CodexRpcClient {
  readonly requests: RecordedRequest[] = [];
  readonly waitCalls: Array<{ timeoutMs: number; expectedThreadId?: string; expectedTurnId?: string }> = [];
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

  async waitForTurnCompletion(
    timeoutMs: number,
    expectedThreadId?: string,
    expectedTurnId?: string
  ): Promise<CodexTurnWaitResult> {
    this.waitCalls.push({
      timeoutMs,
      ...(expectedThreadId ? { expectedThreadId } : {}),
      ...(expectedTurnId ? { expectedTurnId } : {})
    });
    const queued = this.script.waitResults?.shift();
    const result =
      queued ??
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

  it('resumes a thread and fires turn/start without blocking on completion', async () => {
    const { backend, clients } = createHarness([
      {
        onRequest: (method) => {
          if (method === 'thread/start') {
            return { thread: { id: 'thr_seed' } };
          }
          return {};
        }
      },
      {
        onRequest: (method) => {
          if (method === 'thread/resume' || method === 'turn/start') {
            return {};
          }
          throw new Error(`Unexpected method: ${method}`);
        }
      },
      {
        onRequest: (method, params) => {
          if (method !== 'thread/read') {
            throw new Error(`Unexpected method: ${method}`);
          }
          expect(params).toEqual({ threadId: 'thr_seed', includeTurns: true });
          return {
            thread: {
              turns: [
                {
                  items: [
                    { type: 'userMessage', id: 'item-1', content: [] },
                    { type: 'agentMessage', id: 'item-2', text: 'Done here' }
                  ]
                }
              ]
            }
          };
        }
      }
    ]);

    const created = await backend.createSession('riven-jg', '/tmp/repo', 'gpt-5.3-codex');
    const sendResult = await backend.sendMessage('riven-jg', created.threadId, 'Write tests', {
      workspacePath: '/tmp/repo',
      model: 'gpt-5.3-codex'
    });

    expect(sendResult).toEqual({
      threadId: 'thr_seed',
      appServerPid: 9001,
      appServerPort: 4510
    });
    expect(clients[1].requests.map((entry) => entry.method)).toEqual(['thread/resume', 'turn/start']);
    // getLastAssistantMessages reads from thread/read, not from send result
    await expect(backend.getLastAssistantMessages('riven-jg', created.threadId, 1)).resolves.toEqual(['Done here']);
    expect(clients[2].requests.map((entry) => entry.method)).toEqual(['thread/read']);
    // getSessionStatus returns idle since no lastTurnStatus set by fire-and-forget send
    expect(backend.getSessionStatus('riven-jg')).toBe('idle');
  });

  it('reads assistant messages from thread/read even when in-memory history is empty', async () => {
    const { backend, clients } = createHarness([
      {
        onRequest: (method, params) => {
          if (method !== 'thread/read') {
            throw new Error(`Unexpected method: ${method}`);
          }

          expect(params).toEqual({
            threadId: 'thr_history',
            includeTurns: true
          });

          return {
            thread: {
              turns: [
                {
                  items: [
                    { type: 'userMessage', id: 'item-1', content: [] },
                    { type: 'agentMessage', id: 'item-2', text: 'first reply' }
                  ]
                },
                {
                  items: [
                    { type: 'agentMessage', id: 'item-3', text: 'commentary block', phase: 'commentary' },
                    { type: 'agentMessage', id: 'item-4', text: 'final reply', phase: 'final_answer' }
                  ]
                }
              ]
            }
          };
        }
      }
    ]);

    await expect(backend.getLastAssistantMessages('jinx-bot', 'thr_history', 2)).resolves.toEqual([
      'commentary block',
      'final reply'
    ]);

    expect(clients).toHaveLength(1);
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/read']);
  });

  it('returns no assistant messages when thread/read includeTurns is unavailable before first user message', async () => {
    const { backend, clients } = createHarness([
      {
        onRequest: (method) => {
          if (method !== 'thread/read') {
            throw new Error(`Unexpected method: ${method}`);
          }

          throw new Error(
            'thread/read failed: thread thr_new is not materialized yet; includeTurns is unavailable before first user message'
          );
        }
      }
    ]);

    await expect(backend.getLastAssistantMessages('sona-sup', 'thr_new', 1)).resolves.toEqual([]);
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/read']);
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
    expect(result.appServerPid).toBe(9001);
    expect(clients[0].requests.map((entry) => entry.method)).toEqual([
      'thread/resume',
      'thread/start',
      'turn/start'
    ]);
  });

  it('does not return fast-captured assistantText when the early wait times out', async () => {
    const { backend, clients } = createHarness([
      {
        waitResult: {
          completed: false,
          timedOut: true,
          elapsedMs: 3_000,
          status: 'interrupted',
          errorMessage: 'Timed out waiting for Codex turn completion',
          assistantText: 'partial streamed output'
        },
        onRequest: (method) => {
          if (method === 'thread/start') {
            return { thread: { id: 'thr_slow' } };
          }
          if (method === 'turn/start') {
            return { turn: { id: 'turn_slow_1' } };
          }
          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const sendResult = await backend.sendMessage('vex-mid', '', 'Write a long answer', {
      workspacePath: '/tmp/repo'
    });

    expect(sendResult).toEqual({
      threadId: 'thr_slow',
      appServerPid: 9001,
      appServerPort: 4510,
      turnId: 'turn_slow_1'
    });
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/start', 'turn/start']);
    expect(clients[0].waitCalls).toEqual([
      { timeoutMs: 3_000, expectedThreadId: 'thr_slow', expectedTurnId: 'turn_slow_1' }
    ]);
    expect(backend.getSessionStatus('vex-mid')).toBe('idle');
  });

  it('send returns fire-and-forget result; waitForThread surfaces failed turn', async () => {
    const { backend, clients } = createHarness([
      {
        onRequest: (method) => {
          if (method === 'thread/start') {
            return { thread: { id: 'thr_failed' } };
          }
          if (method === 'turn/start') {
            return {};
          }
          throw new Error(`Unexpected method: ${method}`);
        }
      },
      {
        waitResult: {
          completed: true,
          timedOut: false,
          elapsedMs: 8,
          status: 'failed',
          errorMessage: 'tool execution failed'
        },
        onRequest: (method) => {
          if (method === 'thread/resume') {
            return { thread: { id: 'thr_failed', status: { active: { activeFlags: [] } } } };
          }
          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const sendResult = await backend.sendMessage('ahri-mid', '', 'Break intentionally', {
      workspacePath: '/tmp/repo'
    });
    expect(sendResult).toEqual({ threadId: 'thr_failed', appServerPid: 9001, appServerPort: 4510 });
    // getSessionStatus returns idle after send (no lastTurnStatus set yet)
    expect(backend.getSessionStatus('ahri-mid')).toBe('idle');

    // waitForThread surfaces the failure
    const waitResult = await backend.waitForThread('ahri-mid', 'thr_failed', 2_000);
    expect(waitResult).toMatchObject({ completed: true, timedOut: false, status: 'failed', errorMessage: 'tool execution failed' });
    expect(clients[0].requests.map((e) => e.method)).toEqual(['thread/start', 'turn/start']);
    expect(clients[1].requests.map((e) => e.method)).toEqual(['thread/resume']);
  });

  it('reconnects and waits for an active thread turn via thread/resume', async () => {
    const { backend, clients } = createHarness([
      {
        waitResult: {
          completed: true,
          timedOut: false,
          elapsedMs: 17,
          status: 'completed'
        },
        onRequest: (method) => {
          if (method === 'thread/resume') {
            return {
              thread: {
                id: 'thr_active',
                status: { active: { activeFlags: [] } }
              }
            };
          }

          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const result = await backend.waitForThread('zed-mid', 'thr_active', 5_000);

    expect(result).toMatchObject({
      completed: true,
      timedOut: false,
      status: 'completed'
    });
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/resume']);
    expect(clients[0].waitCalls).toEqual([{ timeoutMs: 5_000, expectedThreadId: 'thr_active' }]);
  });

  it('waitForThread loops across multiple completed turns until the thread is no longer active', async () => {
    const { backend, clients } = createHarness([
      {
        waitResult: {
          completed: true,
          timedOut: false,
          elapsedMs: 10,
          status: 'completed',
          assistantText: 'progress update'
        },
        onRequest: (method) => {
          if (method === 'thread/resume') {
            return {
              thread: {
                id: 'thr_multi',
                status: { active: { activeFlags: [] } }
              }
            };
          }
          throw new Error(`Unexpected method: ${method}`);
        }
      },
      {
        waitResult: {
          completed: true,
          timedOut: false,
          elapsedMs: 12,
          status: 'completed',
          assistantText: 'final answer'
        },
        onRequest: (method) => {
          if (method === 'thread/resume') {
            return {
              thread: {
                id: 'thr_multi',
                status: { active: { activeFlags: [] } }
              }
            };
          }
          throw new Error(`Unexpected method: ${method}`);
        }
      },
      {
        onRequest: (method) => {
          if (method === 'thread/resume') {
            return {
              thread: {
                id: 'thr_multi',
                status: 'idle'
              }
            };
          }
          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const result = await backend.waitForThread('yasuo-mid', 'thr_multi', 5_000);

    expect(result).toMatchObject({
      completed: true,
      timedOut: false,
      status: 'completed',
      assistantText: 'final answer'
    });
    expect(clients).toHaveLength(3);
    expect(clients.map((client) => client.requests.map((entry) => entry.method))).toEqual([
      ['thread/resume'],
      ['thread/resume'],
      ['thread/resume']
    ]);
    expect(clients[0].waitCalls).toEqual([{ timeoutMs: 5_000, expectedThreadId: 'thr_multi' }]);
    expect(clients[1].waitCalls).toEqual([{ timeoutMs: expect.any(Number), expectedThreadId: 'thr_multi' }]);
    expect(clients[2].waitCalls).toEqual([]);
  });

  it('returns immediately when thread/resume shows no active turn', async () => {
    const { backend, clients } = createHarness([
      {
        onRequest: (method) => {
          if (method === 'thread/resume') {
            return {
              thread: {
                id: 'thr_idle',
                status: 'idle'
              }
            };
          }

          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const result = await backend.waitForThread('orianna-mid', 'thr_idle', 5_000);

    expect(result).toMatchObject({
      completed: true,
      timedOut: false,
      elapsedMs: 0,
      status: 'completed'
    });
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/resume']);
  });

  it('waits for the specific started turn ID even when thread status polling would be unreliable', async () => {
    const { backend, clients } = createHarness([
      {
        waitResult: {
          completed: true,
          timedOut: false,
          elapsedMs: 1_250,
          status: 'completed',
          assistantText: 'timed command done.'
        },
        onRequest: (method) => {
          if (method === 'thread/resume') {
            return { thread: { id: 'thr_timed', status: 'idle' } };
          }
          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const result = await backend.waitForThread('kennen-sup', 'thr_timed', 40_000, 'turn_timed');

    expect(result).toMatchObject({
      completed: true,
      timedOut: false,
      status: 'completed',
      assistantText: 'timed command done.'
    });
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/resume']);
    expect(clients[0].waitCalls).toEqual([
      { timeoutMs: 40_000, expectedThreadId: 'thr_timed', expectedTurnId: 'turn_timed' }
    ]);
  });

  it('treats unknown runtime status as completed (idle thread)', async () => {
    const { backend, clients } = createHarness([
      {
        onRequest: (method) => {
          if (method === 'thread/resume') {
            // thread/resume returns no thread status field — results in 'unknown'
            return {};
          }

          throw new Error(`Unexpected method: ${method}`);
        }
      }
    ]);

    const result = await backend.waitForThread('karma-sup', 'thr_unknown', 5_000);

    expect(result).toMatchObject({
      completed: true,
      timedOut: false,
      elapsedMs: 0,
      status: 'completed'
    });
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/resume']);
  });

  it('ignores turn/completed notifications for other threads while waiting for a specific thread', async () => {
    const client = new CodexWebSocketRpcClient('ws://127.0.0.1:65535');
    let settled = false;
    const waitPromise = client.waitForTurnCompletion(1_000, 'thr_target').then((result) => {
      settled = true;
      return result;
    });

    (client as unknown as { handleNotification: (n: { method: string; params?: unknown }) => void }).handleNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thr_other',
        turn: { status: 'completed' }
      }
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    (client as unknown as { handleNotification: (n: { method: string; params?: unknown }) => void }).handleNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thr_target',
        turn: { status: 'completed' }
      }
    });

    await expect(waitPromise).resolves.toMatchObject({
      completed: true,
      timedOut: false,
      status: 'completed'
    });
  });

  it('checks thread/read for specific Codex thread existence', async () => {
    const threadReadScript = {
      onRequest: (method: string, params: unknown) => {
        if (method !== 'thread/read') {
          throw new Error(`Unexpected method: ${method}`);
        }

        const request = params as { threadId?: string; includeTurns?: boolean } | undefined;
        expect(request?.includeTurns).toBe(false);

        if (request?.threadId === 'thr_target') {
          return {
            thread: {
              id: 'thr_target',
              turns: []
            }
          };
        }

        throw new Error(`thread/read failed: thread not loaded: ${request?.threadId}`);
      }
    } satisfies FakeClientScript;

    const { backend, daemon, clients } = createHarness([threadReadScript, threadReadScript]);

    await expect(
      backend.sessionExists('fizz-top', daemon.server.pid, daemon.server.port, 'thr_target')
    ).resolves.toBe(true);
    await expect(
      backend.sessionExists('fizz-top', daemon.server.pid, daemon.server.port, 'thr_missing')
    ).resolves.toBe(false);

    expect(clients).toHaveLength(2);
    expect(clients[0].requests.map((entry) => entry.method)).toEqual(['thread/read']);
    expect(clients[1].requests.map((entry) => entry.method)).toEqual(['thread/read']);
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
