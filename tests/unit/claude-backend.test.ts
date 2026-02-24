import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeBackend } from '../../src/backends/claude-backend';
import { ClaudeTmuxBackend } from '../../src/backends/claude-tmux';
import { StoredSession } from '../../src/types';

vi.mock('../../src/transcript/claude-parser', () => ({
  getClaudeTranscriptPath: () => '/tmp/fake-transcript.jsonl',
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  countSystemEntries: vi.fn().mockReturnValue(0),
  extractTextBlocks: vi.fn().mockReturnValue([]),
  getAssistantTextBlocks: vi.fn().mockReturnValue([]),
  inferTranscriptStatus: vi.fn().mockReturnValue('idle')
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ mtimeMs: 1 })
}));

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    championId: 'fizz-top',
    internalId: 'uuid-test',
    cli: 'claude',
    mode: 'native',
    path: '/tmp/workspace',
    status: 'active',
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    ...overrides
  };
}

describe('ClaudeBackend.wait', () => {
  let raw: ClaudeTmuxBackend;
  let backend: ClaudeBackend;

  beforeEach(() => {
    raw = new ClaudeTmuxBackend();
    backend = new ClaudeBackend(raw);
  });

  it('returns early with error when tmux session dies during wait', async () => {
    let pollCount = 0;
    vi.spyOn(raw, 'sessionExists').mockImplementation(async () => {
      return 'dead';
    });

    // Make stat always return a stable mtime so transcript is never re-read
    const { stat } = await import('node:fs/promises');
    (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1 });

    const session = makeSession();
    // Use a long timeout so we'd definitely hang without the dead-session check.
    // intervalMs=1 to spin fast; the liveness check fires on the 10th poll.
    const result = await backend.wait(session, 60_000, 1);

    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.errorToThrow).toBeDefined();
    expect(result.errorToThrow!.message).toBe('tmux session died during wait');
    expect(result.storeUpdate).toEqual(
      expect.objectContaining({ status: 'inactive', lastTurnError: 'tmux session died during wait' })
    );
  });

  it('does not error when sessionExists returns unknown', async () => {
    vi.spyOn(raw, 'sessionExists').mockResolvedValue('unknown');

    const { stat } = await import('node:fs/promises');
    (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ mtimeMs: 1 });

    const session = makeSession();
    // Short timeout — should time out normally without erroring on 'unknown'
    const result = await backend.wait(session, 50, 1);

    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.errorToThrow).toBeUndefined();
  });
});
