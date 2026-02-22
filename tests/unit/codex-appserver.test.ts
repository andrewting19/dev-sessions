import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
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

  constructor(pid: number) {
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

function createBackendHarness(
  onOutgoingMessage: (message: RpcMessage, proc: FakeCodexProcess, processIndex: number) => void
): {
  backend: CodexAppServerBackend;
  processes: FakeCodexProcess[];
  outgoingMessages: Array<{ processIndex: number; message: RpcMessage }>;
} {
  const processes: FakeCodexProcess[] = [];
  const outgoingMessages: Array<{ processIndex: number; message: RpcMessage }> = [];

  const backend = new CodexAppServerBackend(() => {
    const processIndex = processes.length;
    const process = new FakeCodexProcess(9000 + processIndex);
    processes.push(process);

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
        outgoingMessages.push({
          processIndex,
          message
        });
        onOutgoingMessage(message, process, processIndex);
      }
    });

    return process as unknown as ChildProcessWithoutNullStreams;
  });

  return {
    backend,
    processes,
    outgoingMessages
  };
}

describe('CodexAppServerBackend', () => {
  it('builds initialize -> initialized -> thread/start JSON-RPC messages', async () => {
    const { backend, outgoingMessages } = createBackendHarness((message, proc) => {
      if (typeof message.id !== 'number') {
        return;
      }

      if (message.method === 'initialize') {
        proc.emitJson({
          jsonrpc: '2.0',
          id: message.id,
          result: {}
        });
      }

      if (message.method === 'thread/start') {
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

    const created = await backend.createSession('fizz-top', '/tmp/workspace', 'gpt-5.3-codex');

    expect(created).toEqual({
      threadId: 'thr_123',
      model: 'gpt-5.3-codex'
    });

    const methods = outgoingMessages
      .filter((entry) => entry.processIndex === 0)
      .map((entry) => entry.message.method);
    expect(methods).toEqual(['initialize', 'initialized', 'thread/start']);
  });

  it('resumes thread and accumulates agent delta notifications into one message', async () => {
    const { backend, outgoingMessages } = createBackendHarness((message, proc, processIndex) => {
      if (processIndex === 0) {
        if (typeof message.id === 'number' && message.method === 'initialize') {
          proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
        }
        if (typeof message.id === 'number' && message.method === 'thread/start') {
          proc.emitJson({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              thread: {
                id: 'thr_seed'
              }
            }
          });
        }
        return;
      }

      if (typeof message.id === 'number' && message.method === 'initialize') {
        proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
      }
      if (typeof message.id === 'number' && message.method === 'thread/resume') {
        proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
      }
      if (typeof message.id === 'number' && message.method === 'turn/start') {
        proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
        proc.emitJson({
          jsonrpc: '2.0',
          method: 'item/agentMessage/delta',
          params: {
            delta: {
              text: 'Done '
            }
          }
        });
        proc.emitJson({
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
        proc.emitJson({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: {
            turn: {
              id: 'turn_1',
              status: 'completed'
            }
          }
        });
      }
    });

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

    const sendMethods = outgoingMessages
      .filter((entry) => entry.processIndex === 1)
      .map((entry) => entry.message.method);
    expect(sendMethods).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
    expect(backend.getLastAssistantMessages('riven-jg', 1)).toEqual(['Done here']);
    expect(backend.getSessionStatus('riven-jg')).toBe('idle');
  });

  it('falls back to thread/start when thread/resume cannot find the rollout', async () => {
    const { backend, outgoingMessages } = createBackendHarness((message, proc) => {
      if (typeof message.id !== 'number') {
        return;
      }

      if (message.method === 'initialize') {
        proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
      }

      if (message.method === 'thread/resume') {
        proc.emitJson({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            message: 'no rollout found for thread id stale-thread'
          }
        });
      }

      if (message.method === 'thread/start') {
        proc.emitJson({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            thread: {
              id: 'thr_fallback'
            }
          }
        });
      }

      if (message.method === 'turn/start') {
        proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
        proc.emitJson({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: {
            turn: {
              id: 'turn_done',
              status: 'completed'
            }
          }
        });
      }
    });

    const result = await backend.sendMessage('fizz-top', 'stale-thread', 'Ship this feature', {
      workspacePath: '/tmp/workspace',
      model: 'gpt-5.3-codex'
    });

    expect(result.threadId).toBe('thr_fallback');
    expect(result.status).toBe('completed');

    expect(outgoingMessages.map((entry) => entry.message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'thread/start',
      'turn/start'
    ]);
  });

  it('captures failed turn completion and reports failed status', async () => {
    const { backend } = createBackendHarness((message, proc) => {
      if (typeof message.id !== 'number') {
        return;
      }

      if (message.method === 'initialize') {
        proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
      }

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
      }

      if (message.method === 'turn/start') {
        proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
        proc.emitJson({
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
      }
    });

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

  it('returns timedOut when turn completion is never emitted before timeout', async () => {
    vi.useFakeTimers();

    const { backend } = createBackendHarness((message, proc) => {
      if (typeof message.id !== 'number') {
        return;
      }

      if (message.method === 'initialize') {
        proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
      }

      if (message.method === 'thread/start') {
        proc.emitJson({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            thread: {
              id: 'thr_timeout'
            }
          }
        });
      }

      if (message.method === 'turn/start') {
        proc.emitJson({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    });

    const sendPromise = backend.sendMessage('teemo-sup', '', 'This should time out', {
      workspacePath: '/tmp/repo',
      timeoutMs: 25
    });
    await vi.advanceTimersByTimeAsync(25);
    const sendResult = await sendPromise;

    expect(sendResult).toMatchObject({
      completed: false,
      timedOut: true,
      status: 'interrupted'
    });
    expect(backend.getSessionStatus('teemo-sup')).toBe('working');
    vi.useRealTimers();
  });

  it('treats missing PID as an existing logical session and kills provided PID', async () => {
    const { backend } = createBackendHarness(() => {
      // no-op
    });

    expect(await backend.sessionExists('fizz-top')).toBe(true);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await backend.killSession('fizz-top', 4321);

    expect(killSpy).toHaveBeenCalledWith(4321, 'SIGTERM');
    killSpy.mockRestore();
  });
});
