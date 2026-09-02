import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationStore } from '../../src/automation/store';
import { StoredSession } from '../../src/types';

describe('AutomationStore', () => {
  let tempDir: string;
  let store: AutomationStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-automation-store-'));
    store = new AutomationStore(path.join(tempDir, 'state.sqlite'));
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('deduplicates retries and preserves FIFO sequence', () => {
    const first = store.enqueueMessage('mayor-mid', 'first', { idempotencyKey: 'case-1' });
    const duplicate = store.enqueueMessage('mayor-mid', 'changed body', { idempotencyKey: 'case-1' });
    const second = store.enqueueMessage('mayor-mid', 'second');

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.body).toBe('first');
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
  });

  it('claims one ordered message per destination and releases the next after completion', () => {
    const first = store.enqueueMessage('mayor-mid', 'first');
    const second = store.enqueueMessage('mayor-mid', 'second');
    const other = store.enqueueMessage('warden-jg', 'other');

    const claimed = store.claimDispatchableMessages('worker-1', 10_000);
    expect(claimed.map((message) => message.id).sort()).toEqual([first.id, other.id].sort());

    store.markMessageDelivered(first.id, 'turn-1');
    expect(store.claimDispatchableMessages('worker-2', 10_000)).toEqual([]);

    store.markMessageTerminal(first.id, 'completed', { result: 'done' });
    expect(store.claimDispatchableMessages('worker-2', 10_000).map((message) => message.id)).toEqual([second.id]);
  });

  it('marks expired dispatch leases uncertain instead of sending again', () => {
    const message = store.enqueueMessage('mayor-mid', 'work', {
      availableAt: '2026-01-01T00:00:00.000Z'
    });
    store.claimDispatchableMessages('worker-1', 1, new Date('2026-01-01T00:00:00.000Z'));

    expect(store.markExpiredDispatchesUncertain(new Date('2026-01-01T00:00:01.000Z'))).toBe(1);
    expect(store.getMessage(message.id)?.status).toBe('delivery_uncertain');
    expect(store.claimDispatchableMessages('worker-2', 10_000, new Date('2026-01-01T00:00:02.000Z'))).toEqual([]);
  });

  it('stores schedules, prevents duplicate runs, and retains deleted schedule history', () => {
    const schedule = store.createSchedule({
      name: 'mayor wake',
      targetSessionId: 'mayor-mid',
      message: 'Review cases.',
      cron: '0 * * * *',
      timezone: 'UTC'
    }, new Date('2026-01-01T01:00:00.000Z'));

    const run = store.createRun(schedule.id, '2026-01-01T01:00:00.000Z');
    expect(run).toBeDefined();
    expect(store.createRun(schedule.id, '2026-01-01T01:00:00.000Z')).toBeUndefined();

    store.setScheduleStatus(schedule.id, 'deleted');
    expect(store.listSchedules()).toEqual([]);
    expect(store.listSchedules(true)).toHaveLength(1);
    expect(store.listRuns(schedule.id)).toHaveLength(1);
  });

  it('advances a due schedule and creates its run only once across workers', () => {
    const databasePath = path.join(tempDir, 'state.sqlite');
    const other = new AutomationStore(databasePath);
    try {
      const schedule = store.createSchedule({
        name: 'one run',
        targetSessionId: 'mayor-mid',
        message: 'wake',
        cron: '* * * * * *',
        timezone: 'UTC'
      }, new Date('2026-01-01T00:00:01.000Z'));
      const next = new Date('2026-01-01T00:00:02.000Z');
      const now = new Date('2026-01-01T00:00:01.000Z');

      const first = store.advanceScheduleAndCreateRun(
        schedule,
        schedule.nextRunAt,
        next,
        'waiting',
        now
      );
      const duplicate = other.advanceScheduleAndCreateRun(
        schedule,
        schedule.nextRunAt,
        next,
        'waiting',
        now
      );

      expect(first).toBeDefined();
      expect(duplicate).toBeUndefined();
      expect(store.listRuns(schedule.id)).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  it('shares maintenance claims across processes', () => {
    const other = new AutomationStore(path.join(tempDir, 'state.sqlite'));
    try {
      const now = new Date('2026-01-01T00:00:00.000Z');
      expect(store.claimMaintenance('cleanup', 60_000, now)).toBe(true);
      expect(other.claimMaintenance('cleanup', 60_000, now)).toBe(false);
      expect(other.claimMaintenance('cleanup', 60_000, new Date('2026-01-01T00:01:00.000Z'))).toBe(true);
    } finally {
      other.close();
    }
  });

  it('stores the complete resume record by backend task ID', () => {
    const session: StoredSession = {
      championId: 'mayor-mid',
      internalId: 'task-123',
      cli: 'codex',
      mode: 'native',
      path: '/repo',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsed: '2026-01-01T00:00:00.000Z'
    };

    store.retireSession(session);
    expect(store.getRetiredSession('task-123')?.session).toEqual(session);
    store.deleteRetiredSession('task-123');
    expect(store.getRetiredSession('task-123')).toBeUndefined();
  });
});
