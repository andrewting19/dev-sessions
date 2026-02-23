import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeTmuxBackend } from '../../src/backends/claude-tmux';

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout?: string, stderr?: string) => void;

const { execFileMock, accessMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  accessMock: vi.fn()
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}));

vi.mock('node:fs/promises', () => ({
  access: accessMock
}));

function mockExecFileSuccess(): void {
  execFileMock.mockImplementation(
    (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      callback(null, '', '');
      return undefined;
    }
  );
}

describe('ClaudeTmuxBackend', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    accessMock.mockReset();
    mockExecFileSuccess();
    // Default: transcript file is immediately available.
    accessMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds yolo startup command with dangerously-skip-permissions', async () => {
    const backend = new ClaudeTmuxBackend();
    await backend.createSession('dev-fizz-top', '/tmp/workspace', 'yolo', 'uuid-yolo');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      [
        'new-session',
        '-d',
        '-s',
        'dev-fizz-top',
        '-n',
        'dev-fizz-top',
        'bash',
        '-lc',
        "cd '/tmp/workspace' && claude --session-id 'uuid-yolo' --dangerously-skip-permissions"
      ],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('builds native startup command without dangerously-skip-permissions', async () => {
    const backend = new ClaudeTmuxBackend();
    await backend.createSession('dev-riven-jg', '/tmp/workspace', 'native', 'uuid-native');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      [
        'new-session',
        '-d',
        '-s',
        'dev-riven-jg',
        '-n',
        'dev-riven-jg',
        'bash',
        '-lc',
        "cd '/tmp/workspace' && claude --session-id 'uuid-native'"
      ],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('builds docker startup command with clauded and sends enter after startup delay', async () => {
    vi.useFakeTimers();

    const backend = new ClaudeTmuxBackend();
    const createPromise = backend.createSession('dev-ahri-mid', '/tmp/workspace', 'docker', 'uuid-docker');
    await vi.advanceTimersByTimeAsync(5_000);
    await createPromise;

    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'which',
      ['clauded'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'tmux',
      [
        'new-session',
        '-d',
        '-s',
        'dev-ahri-mid',
        '-n',
        'dev-ahri-mid',
        'bash',
        '-lc',
        "cd '/tmp/workspace' && clauded --session-id 'uuid-docker'"
      ],
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      'tmux',
      ['send-keys', '-t', 'dev-ahri-mid', 'C-m'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('polls for transcript file before returning from createSession (yolo)', async () => {
    vi.useFakeTimers();

    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // Fail twice then succeed.
    accessMock
      .mockRejectedValueOnce(enoent)
      .mockRejectedValueOnce(enoent)
      .mockResolvedValue(undefined);

    const backend = new ClaudeTmuxBackend();
    const createPromise = backend.createSession('dev-fizz-top', '/tmp/workspace', 'yolo', 'uuid-poll');

    // Advance past two 200ms poll intervals.
    await vi.advanceTimersByTimeAsync(400);
    await createPromise;

    expect(accessMock).toHaveBeenCalledTimes(3);
  });

  it('logs a warning and returns when transcript polling times out', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const backend = new ClaudeTmuxBackend(500);
    const createPromise = backend.createSession('dev-riven-jg', '/tmp/workspace', 'native', 'uuid-timeout');

    await vi.advanceTimersByTimeAsync(600);
    await createPromise;

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Timed out waiting for Claude transcript'));
    warnSpy.mockRestore();
  });

  describe('sessionExists tri-state', () => {
    it('returns alive when tmux has-session succeeds', async () => {
      const backend = new ClaudeTmuxBackend();
      const result = await backend.sessionExists('dev-fizz-top');
      expect(result).toBe('alive');
    });

    it("returns dead when tmux reports can't find session", async () => {
      execFileMock.mockImplementation(
        (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
          callback(Object.assign(new Error("can't find session: dev-fizz-top"), { code: 1 }));
          return undefined;
        }
      );
      const backend = new ClaudeTmuxBackend();
      const result = await backend.sessionExists('dev-fizz-top');
      expect(result).toBe('dead');
    });

    it('returns unknown when tmux returns an unexpected error', async () => {
      execFileMock.mockImplementation(
        (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
          callback(new Error('tmux: command not found'));
          return undefined;
        }
      );
      const backend = new ClaudeTmuxBackend();
      const result = await backend.sessionExists('dev-fizz-top');
      expect(result).toBe('unknown');
    });
  });

  it('sends message text and enter keys in separate tmux commands', async () => {
    vi.useFakeTimers();

    class TestBackend extends ClaudeTmuxBackend {
      override async isClaudeRunning(): Promise<boolean> {
        return true;
      }
    }

    const backend = new TestBackend();
    const sendPromise = backend.sendMessage('dev-volibear-top', "echo 'hello from test'");
    await vi.advanceTimersByTimeAsync(225);
    await sendPromise;

    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'bash',
      [
        '-lc',
        expect.stringContaining("tmux send-keys -l -t 'dev-volibear-top' \"$decoded\"")
      ],
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'tmux',
      ['send-keys', '-t', 'dev-volibear-top', 'C-m'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      'tmux',
      ['send-keys', '-t', 'dev-volibear-top', 'C-m'],
      expect.any(Object),
      expect.any(Function)
    );
  });
});
