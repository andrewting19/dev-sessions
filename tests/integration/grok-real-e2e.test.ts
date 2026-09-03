import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrokAppServerBackend } from '../../src/backends/grok-appserver';

const runReal = process.env.DEV_SESSIONS_REAL_GROK_E2E === '1';
const describeReal = runReal ? describe : describe.skip;

describeReal('Grok Build real E2E', () => {
  let workspace = '';
  let sessionId = '';
  const backend = new GrokAppServerBackend();

  beforeAll(async () => {
    await access(path.join(os.homedir(), '.grok', 'bin', 'grok'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-grok-e2e-'));
  });

  afterAll(async () => {
    if (sessionId) {
      await backend.closeSession(sessionId).catch(() => undefined);
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('runs create, non-blocking send, exact wait, replay, continuity, and close on grok-4.6', async () => {
    const created = await backend.createSession(workspace, 'grok-4.6');
    sessionId = created.sessionId;
    expect(created.model).toBe('grok-4.6');

    const first = await backend.sendMessage(
      created.sessionId,
      workspace,
      'Reply with exactly GROK_DEV_SESSIONS_E2E_OK and do not use tools.'
    );
    expect(first.promptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(['working', 'idle']).toContain(await backend.getSessionActivity(created.sessionId));

    const waited = await backend.waitForSession(
      created.sessionId,
      workspace,
      first.promptId,
      120_000,
      500
    );
    expect(waited).toMatchObject({ completed: true, timedOut: false });
    await expect(backend.getLastMessages(created.sessionId, workspace, 1)).resolves.toEqual([
      'GROK_DEV_SESSIONS_E2E_OK'
    ]);

    const second = await backend.sendMessage(
      created.sessionId,
      workspace,
      'What exact token did you return in your previous reply? Reply with only that token.'
    );
    await backend.waitForSession(created.sessionId, workspace, second.promptId, 120_000, 500);
    const logs = await backend.getLogs(created.sessionId, workspace);
    expect(logs.filter((turn) => turn.role === 'assistant').map((turn) => turn.text)).toEqual([
      'GROK_DEV_SESSIONS_E2E_OK',
      'GROK_DEV_SESSIONS_E2E_OK'
    ]);

    await backend.closeSession(created.sessionId);
    sessionId = '';
  }, 240_000);
});
