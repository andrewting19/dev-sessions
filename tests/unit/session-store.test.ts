import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../src/session-store';
import { StoredSession } from '../../src/types';

function createSession(championId: string): StoredSession {
  const now = new Date().toISOString();
  return {
    championId,
    internalId: `${championId}-uuid`,
    cli: 'claude',
    mode: 'native',
    path: '/tmp/project',
    description: `session ${championId}`,
    status: 'active',
    createdAt: now,
    lastUsed: now
  };
}

describe('SessionStore', () => {
  let tmpDir = '';
  let storePath = '';
  let store: SessionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-store-'));
    storePath = path.join(tmpDir, 'sessions.json');
    store = new SessionStore(storePath);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('performs CRUD operations', async () => {
    const session = createSession('fizz-top');

    expect(await store.listSessions()).toEqual([]);

    await store.upsertSession(session);
    expect(await store.getSession('fizz-top')).toEqual(session);

    const updated = await store.updateSession('fizz-top', {
      status: 'inactive',
      lastUsed: '2026-02-21T00:00:00.000Z'
    });

    expect(updated?.status).toBe('inactive');
    expect(updated?.lastUsed).toBe('2026-02-21T00:00:00.000Z');

    const deleted = await store.deleteSession('fizz-top');
    expect(deleted).toBe(true);
    expect(await store.getSession('fizz-top')).toBeUndefined();
  });

  it('persists across store instances', async () => {
    await store.upsertSession(createSession('riven-jg'));

    const reloadedStore = new SessionStore(storePath);
    const sessions = await reloadedStore.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].championId).toBe('riven-jg');
  });

  it('prunes sessions in bulk', async () => {
    await store.upsertSession(createSession('fizz-top'));
    await store.upsertSession(createSession('riven-jg'));

    const removed = await store.pruneSessions(['fizz-top']);
    expect(removed).toBe(1);

    const sessions = await store.listSessions();
    expect(sessions.map((session) => session.championId)).toEqual(['riven-jg']);
  });
});
