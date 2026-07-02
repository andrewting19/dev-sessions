import { describe, expect, it, vi } from 'vitest';
import { buildProgram, SessionManagerLike } from '../../src/cli';
import { StoredSession } from '../../src/types';

function createMockSession(championId: string, overrides: Partial<StoredSession> = {}): StoredSession {
  const now = '2026-02-21T00:00:00.000Z';
  return {
    championId,
    internalId: `${championId}-uuid`,
    cli: 'claude',
    mode: 'native',
    path: '/tmp/workspace',
    status: 'active',
    createdAt: now,
    lastUsed: now,
    ...overrides
  };
}

function createManagerMock(overrides: Partial<SessionManagerLike> = {}): SessionManagerLike {
  return {
    createSession: vi.fn().mockResolvedValue(createMockSession('fizz-top')),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([createMockSession('fizz-top')]),
    getLastAssistantTextBlocks: vi.fn().mockResolvedValue(['done']),
    getSessionStatus: vi.fn().mockResolvedValue('idle'),
    waitForSession: vi.fn().mockResolvedValue({ completed: true, timedOut: false, elapsedMs: 1000 }),
    getSessionLogs: vi.fn().mockResolvedValue([{ role: 'human', text: 'hi' }, { role: 'assistant', text: 'yo' }]),
    inspectSession: vi.fn().mockResolvedValue(createMockSession('fizz-top')),
    setSessionGoal: vi.fn(),
    getSessionGoal: vi.fn(),
    clearSessionGoal: vi.fn(),
    waitForSessionGoal: vi.fn(),
    waitForSessionNextTurn: vi.fn(),
    ...overrides
  } as SessionManagerLike;
}

function createIoCapture() {
  const output = { stdout: '', stderr: '' };
  return {
    io: {
      stdout: { write: (chunk: string): boolean => ((output.stdout += chunk), true) },
      stderr: { write: (chunk: string): boolean => ((output.stderr += chunk), true) }
    },
    output
  };
}

describe('remote CLI surface', () => {
  it('create --host passes the host through and leaves path unset', async () => {
    const remoteSession = createMockSession('riven-jg', { host: 'buildbox', path: '/home/remote/project' });
    const manager = createManagerMock({ createSession: vi.fn().mockResolvedValue(remoteSession) });
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'create', '--host', 'buildbox', '--cli', 'codex']);

    expect(manager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'buildbox', cli: 'codex', path: undefined })
    );
    expect(output.stdout).toContain('Created session riven-jg on buildbox');
  });

  it('create without --host still defaults path locally', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'create']);

    const call = (manager.createSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof call.path).toBe('string');
    expect(call.path.length).toBeGreaterThan(0);
  });

  it('create --host with explicit --path forwards the remote path verbatim', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync([
      'node', 'dev-sessions', 'create', '--host', 'buildbox', '--path', '/home/remote/repo'
    ]);

    expect(manager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'buildbox', path: '/home/remote/repo' })
    );
  });

  it('create --json prints the full session record', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'create', '--path', '/tmp/workspace', '--json']);

    const parsed = JSON.parse(output.stdout) as StoredSession;
    expect(parsed.championId).toBe('fizz-top');
    expect(parsed.internalId).toBe('fizz-top-uuid');
  });

  it('create --id passes the pre-allocated champion ID through', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'create', '--path', '/tmp/workspace', '--id', 'fizz-top']);

    expect(manager.createSession).toHaveBeenCalledWith(expect.objectContaining({ championId: 'fizz-top' }));
  });

  it('send --file - reads the message from stdin', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io, {
      readStdin: async () => 'briefing from stdin\nwith lines'
    });

    await program.parseAsync(['node', 'dev-sessions', 'send', 'fizz-top', '--file', '-']);

    expect(manager.sendMessage).toHaveBeenCalledWith('fizz-top', 'briefing from stdin\nwith lines');
  });

  it('ask --file - reads the message from stdin', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io, {
      readStdin: async () => 'question from stdin'
    });

    await program.parseAsync(['node', 'dev-sessions', 'ask', 'fizz-top', '--file', '-']);

    expect(manager.sendMessage).toHaveBeenCalledWith('fizz-top', 'question from stdin');
    expect(output.stdout).toContain('done');
  });

  it('logs --json prints a lossless JSON turn array', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'logs', 'fizz-top', '--json']);

    expect(JSON.parse(output.stdout)).toEqual([
      { role: 'human', text: 'hi' },
      { role: 'assistant', text: 'yo' }
    ]);
  });

  it('list shows a HOST column with local and remote hosts', async () => {
    const manager = createManagerMock({
      listSessions: vi.fn().mockResolvedValue([
        createMockSession('fizz-top'),
        createMockSession('riven-jg', { host: 'buildbox', path: '/home/remote/project' })
      ])
    });
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'list']);

    expect(output.stdout).toContain('HOST');
    expect(output.stdout).toMatch(/fizz-top.*local/);
    expect(output.stdout).toMatch(/riven-jg.*buildbox/);
  });
});
