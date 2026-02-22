import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeTmuxBackend } from '../../src/backends/claude-tmux';

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout?: string, stderr?: string) => void;

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock
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
    mockExecFileSuccess();
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

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
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
      2,
      'tmux',
      ['send-keys', '-t', 'dev-ahri-mid', 'C-m'],
      expect.any(Object),
      expect.any(Function)
    );
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
