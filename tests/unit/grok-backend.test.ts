import { describe, expect, it, vi } from 'vitest';
import { GrokBackend } from '../../src/backends/grok-backend';
import { GrokAppServerBackend } from '../../src/backends/grok-appserver';
import { StoredSession } from '../../src/types';

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    championId: 'garen-top',
    internalId: 'grok-session-1',
    cli: 'grok',
    mode: 'native',
    path: '/repo',
    status: 'active',
    createdAt: '2026-08-17T00:00:00.000Z',
    lastUsed: '2026-08-17T00:00:00.000Z',
    ...overrides
  };
}

function rawBackend(overrides: Partial<Record<keyof GrokAppServerBackend, unknown>> = {}): GrokAppServerBackend {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'grok-session-1',
      model: 'grok-4.6',
      appServerPid: 42,
      appServerPort: 2419
    }),
    sendMessage: vi.fn().mockResolvedValue({
      promptId: 'prompt-1',
      appServerPid: 42,
      appServerPort: 2419
    }),
    getSessionActivity: vi.fn().mockResolvedValue('idle'),
    waitForSession: vi.fn().mockResolvedValue({ completed: true, timedOut: false, elapsedMs: 10 }),
    getLogs: vi.fn().mockResolvedValue([
      { role: 'human', text: 'hello' },
      { role: 'assistant', text: 'hi' }
    ]),
    getLastMessages: vi.fn().mockResolvedValue(['hi']),
    sessionExists: vi.fn().mockResolvedValue(true),
    closeSession: vi.fn().mockResolvedValue(undefined),
    stopAppServer: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as GrokAppServerBackend;
}

describe('GrokBackend', () => {
  it('creates a native Grok 4.6 session and records daemon metadata', async () => {
    const raw = rawBackend();
    const backend = new GrokBackend(raw);

    const created = await backend.create({
      championId: 'garen-top',
      workspacePath: '/repo',
      mode: 'docker',
      model: 'grok-4.6'
    });

    expect(raw.createSession).toHaveBeenCalledWith('/repo', 'grok-4.6');
    expect(created).toMatchObject({
      internalId: 'grok-session-1',
      mode: 'native',
      model: 'grok-4.6',
      appServerPid: 42,
      appServerPort: 2419,
      grokTurnInProgress: false
    });
  });

  it('tracks an exact prompt ID from non-blocking send through wait', async () => {
    const raw = rawBackend();
    const backend = new GrokBackend(raw);
    const stored = session({ grokTurnInProgress: true, grokActivePromptId: 'prompt-1' });

    const sent = await backend.send(stored, 'hello');
    expect(sent).toMatchObject({ grokTurnInProgress: true, grokActivePromptId: 'prompt-1' });

    const waited = await backend.wait(stored, 30_000, 500);
    expect(raw.waitForSession).toHaveBeenCalledWith(
      'grok-session-1',
      '/repo',
      'prompt-1',
      30_000,
      500
    );
    expect(waited.completed).toBe(true);
    expect(waited.storeUpdate).toMatchObject({
      grokTurnInProgress: false,
      lastTurnStatus: 'completed',
      lastAssistantMessages: ['hi']
    });
  });

  it('maps Grok roster activity to the public status values', async () => {
    const working = new GrokBackend(rawBackend({ getSessionActivity: vi.fn().mockResolvedValue('working') }));
    const needsInput = new GrokBackend(rawBackend({ getSessionActivity: vi.fn().mockResolvedValue('needs_input') }));
    const idle = new GrokBackend(rawBackend({ getSessionActivity: vi.fn().mockResolvedValue('dormant') }));

    await expect(working.status(session())).resolves.toMatchObject({ status: 'working' });
    await expect(needsInput.status(session())).resolves.toMatchObject({ status: 'waiting_for_input' });
    await expect(idle.status(session())).resolves.toMatchObject({ status: 'idle' });
  });

  it('stops only the local Grok daemon after the last local Grok session is killed', async () => {
    const raw = rawBackend();
    const backend = new GrokBackend(raw);

    await backend.afterKill([session({ host: 'buildbox' })]);
    expect(raw.stopAppServer).toHaveBeenCalledOnce();

    vi.mocked(raw.stopAppServer).mockClear();
    await backend.afterKill([session()]);
    expect(raw.stopAppServer).not.toHaveBeenCalled();
  });
});
