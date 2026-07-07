import { describe, expect, it, vi } from 'vitest';
import { RemoteCommandError, RemoteHostClient } from '../../src/remote/remote-client';
import type { SshRunner, SshRunResult } from '../../src/remote/ssh-runner';
import { StoredSession } from '../../src/types';

interface RecordedRun {
  host: string;
  remoteBin: string;
  args: string[];
  stdin?: string;
}

function createFakeRunner(results: SshRunResult[]): { runner: SshRunner; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  const queue = [...results];

  const runner = {
    run: vi.fn(async (host: string, remoteBin: string, args: string[], options?: { stdin?: string }) => {
      runs.push({ host, remoteBin, args, stdin: options?.stdin });
      const next = queue.shift();
      if (!next) {
        throw new Error('fake runner exhausted');
      }
      return next;
    })
  } as unknown as SshRunner;

  return { runner, runs };
}

function ok(stdout: string): SshRunResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function mockRemoteSession(championId: string): StoredSession {
  const now = '2026-07-01T00:00:00.000Z';
  return {
    championId,
    internalId: `${championId}-uuid`,
    cli: 'codex',
    mode: 'native',
    path: '/home/andrew/project',
    status: 'active',
    createdAt: now,
    lastUsed: now
  };
}

describe('RemoteHostClient', () => {
  it('reads the remote version', async () => {
    const { runner, runs } = createFakeRunner([ok('0.3.2\n')]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    expect(await client.version()).toBe('0.3.2');
    expect(runs[0]).toMatchObject({ host: 'buildbox', remoteBin: 'dev-sessions', args: ['--version'] });
  });

  it('creates with a pre-allocated ID and parses the session record', async () => {
    const session = mockRemoteSession('fizz-top');
    const { runner, runs } = createFakeRunner([ok(JSON.stringify(session))]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    const created = await client.create({
      championId: 'fizz-top',
      cli: 'codex',
      mode: 'native',
      path: '/home/andrew/project',
      description: 'remote work'
    });

    expect(created.championId).toBe('fizz-top');
    expect(runs[0].args).toEqual([
      'create', '--json', '--id', 'fizz-top', '--cli', 'codex', '--mode', 'native',
      '--path', '/home/andrew/project', '--description', 'remote work'
    ]);
  });

  it('omits --path when no path is given so the remote resolves its own default', async () => {
    const { runner, runs } = createFakeRunner([ok(JSON.stringify(mockRemoteSession('fizz-top')))]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    await client.create({ championId: 'fizz-top', cli: 'claude', mode: 'native' });

    expect(runs[0].args).not.toContain('--path');
  });

  it('sends message content over stdin, never argv', async () => {
    const { runner, runs } = createFakeRunner([ok('Sent message to fizz-top\n')]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    await client.send('fizz-top', 'a very long\nmulti-line briefing');

    expect(runs[0].args).toEqual(['send', 'fizz-top', '--file', '-']);
    expect(runs[0].stdin).toBe('a very long\nmulti-line briefing');
  });

  it('parses status output and rejects unknown values', async () => {
    const { runner } = createFakeRunner([ok('working\n'), ok('sideways\n')]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    expect(await client.status('fizz-top')).toBe('working');
    await expect(client.status('fizz-top')).rejects.toThrow(/invalid status/);
  });

  it('maps wait exit code 124 to a timed-out result', async () => {
    const { runner } = createFakeRunner([
      { exitCode: 124, stdout: '', stderr: 'Timed out waiting for fizz-top\n' }
    ]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    const result = await client.wait('fizz-top', { timeoutSeconds: 30 });
    expect(result.timedOut).toBe(true);
    expect(result.completed).toBe(false);
  });

  it('passes wait timeout and interval through to the remote CLI', async () => {
    const { runner, runs } = createFakeRunner([ok('completed\n')]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    const result = await client.wait('fizz-top', { timeoutSeconds: 600, intervalSeconds: 5 });

    expect(result.completed).toBe(true);
    expect(runs[0].args).toEqual(['wait', 'fizz-top', '--timeout', '600', '--interval', '5']);
  });

  it('surfaces remote failures with the remote exit code and stderr', async () => {
    const { runner } = createFakeRunner([
      { exitCode: 1, stdout: '', stderr: 'Session not found: fizz-top\n' }
    ]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    await expect(client.status('fizz-top')).rejects.toMatchObject({
      name: 'RemoteCommandError',
      exitCode: 1,
      message: expect.stringContaining('Session not found: fizz-top')
    });
  });

  it('explains a missing remote binary (exit 127)', async () => {
    const { runner } = createFakeRunner([
      { exitCode: 127, stdout: '', stderr: 'bash: dev-sessions: command not found\n' }
    ]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    await expect(client.version()).rejects.toThrow(/DEV_SESSIONS_REMOTE_BIN/);
  });

  it('builds goal updates as CLI flags', async () => {
    const goal = {
      threadId: 'thr_1',
      objective: 'make tests pass',
      status: 'active',
      tokenBudget: 200000,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1
    };
    const { runner, runs } = createFakeRunner([ok(JSON.stringify(goal)), ok(JSON.stringify(goal)), ok(JSON.stringify(goal))]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    await client.setGoal('fizz-top', { objective: 'make tests pass', status: 'active', tokenBudget: 200000 });
    expect(runs[0].args).toEqual(['goal', 'fizz-top', '--budget', '200000', '--json', '--', 'make tests pass']);

    await client.setGoal('fizz-top', { status: 'active' });
    expect(runs[1].args).toEqual(['goal', 'fizz-top', '--resume', '--json']);

    // Dash-leading multiline objectives must ride after '--' so the remote
    // CLI's option parser doesn't eat them.
    const dashObjective = '- fix parser\n- add tests';
    await client.setGoal('fizz-top', { objective: dashObjective, status: 'active' });
    expect(runs[2].args).toEqual(['goal', 'fizz-top', '--json', '--', dashObjective]);
  });

  it('parses last-message and logs JSON payloads', async () => {
    const { runner } = createFakeRunner([
      ok(JSON.stringify(['block one', 'block\n\ntwo'])),
      ok(JSON.stringify([{ role: 'human', text: 'hi' }, { role: 'assistant', text: 'hello' }]))
    ]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    expect(await client.lastMessages('fizz-top', 2)).toEqual(['block one', 'block\n\ntwo']);
    expect(await client.logs('fizz-top')).toEqual([
      { role: 'human', text: 'hi' },
      { role: 'assistant', text: 'hello' }
    ]);
  });

  it('throws RemoteCommandError on unparseable JSON output', async () => {
    const { runner } = createFakeRunner([ok('not json at all')]);
    const client = new RemoteHostClient('buildbox', 'dev-sessions', runner);

    await expect(client.list()).rejects.toBeInstanceOf(RemoteCommandError);
  });
});
