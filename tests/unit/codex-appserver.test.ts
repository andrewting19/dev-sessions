import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CodexAppServerBackend } from '../../src/backends/codex-appserver';

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  constructor(pid: number = 4242) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (typeof signal === 'string') {
      this.signalCode = signal;
    }
    this.emit('exit', this.exitCode, this.signalCode);
    return true;
  }

  emitJson(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

function createBackendHarness(onOutgoingMessage: (message: RpcMessage, proc: FakeCodexProcess) => void): {
  backend: CodexAppServerBackend;
  process: FakeCodexProcess;
  outgoingMessages: RpcMessage[];
} {
  const process = new FakeCodexProcess(9911);
  const outgoingMessages: RpcMessage[] = [];
  let buffered = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string | Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const message = JSON.parse(trimmed) as RpcMessage;
      outgoingMessages.push(message);
      onOutgoingMessage(message, process);
    }
  });

  const backend = new CodexAppServerBackend(
    () => process as unknown as ChildProcessWithoutNullStreams
  );

  return {
    backend,
    process,
    outgoingMessages
  };
}

describe('CodexAppServerBackend', () => {
  it('builds initialize -> initialized -> thread/start JSON-RPC messages', async () => {
    const { backend, outgoingMessages } = createBackendHarness((message, proc) => {
      if (message.method === 'initialize' && typeof message.id === 'number') {
        proc.emitJson({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            serverInfo: {
              name: 'codex-app-server'
            }
          }
        });
      }

      if (message.method === 'thread/start' && typeof message.id === 'number') {
        proc.emitJson({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            thread: {
              id: 'thr_123'
            }
          }
        });
      }
    });

    const created = await backend.createSession('fizz-top', '/tmp/workspace');

    expect(created).toEqual({
      threadId: 'thr_123',
      pid: 9911,
      model: 'o4-mini'
    });

    expect(outgoingMessages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start'
    ]);

    expect(outgoingMessages[0]).toMatchObject({
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'dev-sessions',
          title: 'dev-sessions',
          version: '0.1.0'
        },
        capabilities: {
          experimentalApi: true
        }
      }
    });

    expect(outgoingMessages[1]).toEqual({
      jsonrpc: '2.0',
      method: 'initialized',
      params: {}
    });

    expect(outgoingMessages[2]).toMatchObject({
      method: 'thread/start',
      params: {
        model: 'o4-mini',
        cwd: '/tmp/workspace',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access'
      }
    });
  });

  it('builds turn/start and accumulates agent delta notifications into one message', async () => {
    const { backend, process, outgoingMessages } = createBackendHarness((message, proc) => {
      if ((message.method === 'initialize' || message.method === 'thread/start' || message.method === 'turn/start') &&
        typeof message.id === 'number') {
        if (message.method === 'thread/start') {
          proc.emitJson({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              thread: {
                id: 'thr_stream'
              }
            }
          });
          return;
        }

        proc.emitJson({
          jsonrpc: '2.0',
          id: message.id,
          result: {}
        });
      }
    });

    await backend.createSession('riven-jg', '/tmp/repo');
    await backend.sendMessage('riven-jg', 'thr_stream', 'Write tests');

    const turnStart = outgoingMessages.find((message) => message.method === 'turn/start');
    expect(turnStart).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thr_stream',
        input: [{ type: 'text', text: 'Write tests' }]
      }
    });

    const waitPromise = backend.waitForTurn('riven-jg', 2000);

    process.emitJson({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        delta: {
          text: 'Done '
        }
      }
    });
    process.emitJson({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        item: {
          delta: {
            text: 'here'
          }
        }
      }
    });
    process.emitJson({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_1',
          status: 'completed'
        }
      }
    });

    const result = await waitPromise;
    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe('completed');
    expect(backend.getLastAssistantMessages('riven-jg', 1)).toEqual(['Done here']);
  });

  it('parses failed turn completion and surfaces error state', async () => {
    const { backend, process } = createBackendHarness((message, proc) => {
      if ((message.method === 'initialize' || message.method === 'thread/start' || message.method === 'turn/start') &&
        typeof message.id === 'number') {
        if (message.method === 'thread/start') {
          proc.emitJson({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              thread: {
                id: 'thr_failed'
              }
            }
          });
          return;
        }

        proc.emitJson({
          jsonrpc: '2.0',
          id: message.id,
          result: {}
        });
      }
    });

    await backend.createSession('ahri-mid', '/tmp/repo');
    await backend.sendMessage('ahri-mid', 'thr_failed', 'Break intentionally');
    const waitPromise = backend.waitForTurn('ahri-mid', 2000);

    process.emitJson({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_failed',
          status: 'failed',
          error: {
            message: 'tool execution failed'
          }
        }
      }
    });

    const waitResult = await waitPromise;
    expect(waitResult.status).toBe('failed');
    expect(waitResult.errorMessage).toBe('tool execution failed');
    expect(() => backend.getSessionStatus('ahri-mid')).toThrow('Codex turn failed: tool execution failed');
  });
});
