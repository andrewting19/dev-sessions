import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('warns when invalid session records are dropped during read', async () => {
    const valid = createSession('fizz-top');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await writeFile(
        storePath,
        JSON.stringify(
          {
            version: 1,
            sessions: [
              valid,
              {
                championId: 'broken-mid',
                internalId: 123,
                cli: 'codex'
              }
            ]
          },
          null,
          2
        ),
        'utf8'
      );

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].championId).toBe('fizz-top');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('ignoring invalid session record');
      expect(warnSpy.mock.calls[0]?.[0]).toContain('broken-mid');
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe('concurrent access', () => {
    it('parallel upserts do not lose sessions', async () => {
      const ids = Array.from({ length: 20 }, (_, i) => `champ-${i}`);

      await Promise.all(ids.map((id) => store.upsertSession(createSession(id))));

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(20);
      const storedIds = sessions.map((s) => s.championId).sort();
      expect(storedIds).toEqual(ids.sort());
    });

    it('parallel deletes do not wipe unrelated sessions', async () => {
      // Seed 10 sessions
      for (let i = 0; i < 10; i++) {
        await store.upsertSession(createSession(`s-${i}`));
      }

      // Delete odd-numbered sessions in parallel
      const toDelete = [1, 3, 5, 7, 9].map((i) => `s-${i}`);
      await Promise.all(toDelete.map((id) => store.deleteSession(id)));

      const remaining = await store.listSessions();
      const remainingIds = remaining.map((s) => s.championId).sort();
      expect(remainingIds).toEqual(['s-0', 's-2', 's-4', 's-6', 's-8']);
    });

    it('parallel updates do not overwrite each other', async () => {
      await store.upsertSession(createSession('target'));
      await store.upsertSession(createSession('bystander'));

      // Run many concurrent updates to the same session
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.updateSession('target', {
            description: `update-${i}`,
            lastUsed: new Date(Date.now() + i).toISOString()
          })
        )
      );

      // Bystander should be untouched
      const bystander = await store.getSession('bystander');
      expect(bystander).toBeDefined();
      expect(bystander!.championId).toBe('bystander');

      // Target should exist with one of the updates applied
      const target = await store.getSession('target');
      expect(target).toBeDefined();
      expect(target!.description).toMatch(/^update-\d$/);
    });

    it('mixed parallel creates and deletes are consistent', async () => {
      // Pre-populate sessions that will be deleted
      for (let i = 0; i < 5; i++) {
        await store.upsertSession(createSession(`old-${i}`));
      }

      // Concurrently create new sessions and delete old ones
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 5; i++) {
        ops.push(store.upsertSession(createSession(`new-${i}`)));
        ops.push(store.deleteSession(`old-${i}`));
      }
      await Promise.all(ops);

      const sessions = await store.listSessions();
      const ids = sessions.map((s) => s.championId).sort();

      // All old sessions deleted, all new sessions present
      for (let i = 0; i < 5; i++) {
        expect(ids).not.toContain(`old-${i}`);
        expect(ids).toContain(`new-${i}`);
      }
    });

    it('multiple store instances sharing the same path serialize correctly', async () => {
      const store2 = new SessionStore(storePath);

      // Interleave operations across two store instances
      await Promise.all([
        store.upsertSession(createSession('from-store1')),
        store2.upsertSession(createSession('from-store2'))
      ]);

      const sessions = await store.listSessions();
      const ids = sessions.map((s) => s.championId).sort();
      expect(ids).toEqual(['from-store1', 'from-store2']);
    });
  });
});
