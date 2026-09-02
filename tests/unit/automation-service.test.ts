import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationService, AutomationSessionRuntime } from '../../src/automation/service';
import { AutomationStore } from '../../src/automation/store';
import { CreateSessionOptions, ResumeSessionOptions } from '../../src/session-manager';
import { AgentTurnStatus, StoredSession } from '../../src/types';

class FakeRuntime implements AutomationSessionRuntime {
  readonly sessions = new Map<string, StoredSession>();
  readonly statuses = new Map<string, AgentTurnStatus>();
  readonly sent: Array<{ sessionId: string; body: string }> = [];
  readonly retired: string[] = [];
  readonly resumed: string[] = [];
  result = 'RESULT';
  nextId = 1;
  sendError?: Error;
  statusError?: Error;

  async createSession(options: CreateSessionOptions): Promise<StoredSession> {
    const id = options.championId ?? `new-${this.nextId++}`;
    const session = this.makeSession(id, `task-${id}`, options.path ?? '/repo');
    this.sessions.set(id, session);
    this.statuses.set(id, 'idle');
    return session;
  }

  async resumeSession(options: ResumeSessionOptions): Promise<StoredSession> {
    const id = options.championId ?? `resumed-${this.nextId++}`;
    const session = this.makeSession(id, options.taskId, options.path ?? '/repo');
    this.sessions.set(id, session);
    this.statuses.set(id, 'idle');
    this.resumed.push(options.taskId);
    return session;
  }

  async retireSession(championId: string): Promise<StoredSession> {
    const session = await this.inspectSession(championId);
    this.sessions.delete(championId);
    this.statuses.delete(championId);
    this.retired.push(championId);
    return session;
  }

  async sendMessageDirect(championId: string, message: string): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push({ sessionId: championId, body: message });
    this.statuses.set(championId, 'working');
    const session = await this.inspectSession(championId);
    session.codexActiveTurnId = `turn-${this.sent.length}`;
  }

  async getSessionStatus(championId: string): Promise<AgentTurnStatus> {
    if (this.statusError) throw this.statusError;
    const status = this.statuses.get(championId);
    if (!status) throw new Error(`Session not found: ${championId}`);
    return status;
  }

  async getLastAssistantTextBlocks(): Promise<string[]> {
    return [this.result];
  }

  async waitForSession(championId: string): Promise<{ completed: boolean; timedOut: boolean }> {
    const status = await this.getSessionStatus(championId);
    return { completed: status === 'idle', timedOut: status !== 'idle' };
  }

  async inspectSession(championId: string): Promise<StoredSession> {
    const session = this.sessions.get(championId);
    if (!session) throw new Error(`Session not found: ${championId}`);
    return session;
  }

  async listSessions(): Promise<StoredSession[]> {
    return [...this.sessions.values()];
  }

  makeSession(id: string, taskId: string, workspace: string = '/repo', lastUsed: string = '2026-01-01T00:00:00.000Z'): StoredSession {
    return {
      championId: id,
      internalId: taskId,
      cli: 'codex',
      mode: 'native',
      path: workspace,
      status: 'active',
      createdAt: lastUsed,
      lastUsed
    };
  }
}

describe('AutomationService', () => {
  let tempDir: string;
  let store: AutomationStore;
  let runtime: FakeRuntime;
  let now: Date;
  let service: AutomationService;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-automation-service-'));
    store = new AutomationStore(path.join(tempDir, 'state.sqlite'));
    runtime = new FakeRuntime();
    now = new Date('2026-01-01T00:00:00.000Z');
    service = new AutomationService(store, runtime, {
      workerId: 'test-worker',
      cleanupHours: 0,
      now: () => now,
      sleep: async () => {}
    });
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('waits for a busy session and delivers queued messages in order', async () => {
    const session = runtime.makeSession('mayor-mid', 'task-mayor');
    runtime.sessions.set(session.championId, session);
    runtime.statuses.set(session.championId, 'working');
    const first = service.enqueueMessage(session.championId, 'first');
    const second = service.enqueueMessage(session.championId, 'second');

    await service.tick();
    expect(runtime.sent).toEqual([]);
    expect(service.getMessage(first.id)?.status).toBe('waiting');

    runtime.statuses.set(session.championId, 'idle');
    now = new Date(now.getTime() + 2_000);
    await service.tick();
    expect(runtime.sent.map((entry) => entry.body)).toEqual(['first']);

    runtime.statuses.set(session.championId, 'idle');
    now = new Date(now.getTime() + 2_000);
    await service.tick();
    expect(service.getMessage(first.id)?.status).toBe('completed');
    expect(service.getMessage(first.id)?.result).toBe('RESULT');
    expect(runtime.sent.map((entry) => entry.body)).toEqual(['first', 'second']);
  });

  it('connects replies to the original message and correlation', () => {
    const original = service.enqueueMessage('mayor-mid', 'request', {
      sourceSessionId: 'worker-jg'
    });
    const reply = service.replyToMessage(original.id, 'response');

    expect(reply.targetSessionId).toBe('worker-jg');
    expect(reply.sourceSessionId).toBe('mayor-mid');
    expect(reply.replyToMessageId).toBe(original.id);
    expect(reply.correlationId).toBe(original.correlationId);
  });

  it('runs at most one current occurrence after downtime', async () => {
    const session = runtime.makeSession('mayor-mid', 'task-mayor');
    runtime.sessions.set(session.championId, session);
    runtime.statuses.set(session.championId, 'idle');
    const schedule = await service.createSessionSchedule({
      name: 'mayor wake',
      targetSessionId: session.championId,
      message: 'wake',
      cron: '* * * * * *',
      timezone: 'UTC',
      maxLatenessMs: 60_000
    });

    now = new Date('2026-01-01T00:00:10.000Z');
    await service.tick();
    expect(service.listRuns(schedule.id)).toHaveLength(1);
    expect(service.listRuns(schedule.id)[0].scheduledFor).toBe('2026-01-01T00:00:10.000Z');
    expect(service.getSchedule(schedule.id)?.nextRunAt).toBe('2026-01-01T00:00:11.000Z');
  });

  it('resumes a cleaned session by task ID when its schedule runs', async () => {
    const old = runtime.makeSession('old-mayor', 'task-mayor');
    store.retireSession(old, now);
    const schedule = store.createSchedule({
      name: 'mayor wake',
      targetSessionId: old.championId,
      message: 'wake',
      cron: '* * * * * *',
      timezone: 'UTC'
    }, new Date('2026-01-01T00:00:01.000Z'));
    store.updateScheduleTarget(schedule.id, old.championId, old.internalId, now);

    now = new Date('2026-01-01T00:00:01.000Z');
    await service.tick();
    expect(runtime.resumed).toEqual(['task-mayor']);
    expect(service.listRuns(schedule.id)[0].taskId).toBe('task-mayor');
  });

  it('creates a different backend task for every new-session run', async () => {
    const schedule = service.createSchedule({
      name: 'independent worker',
      newSession: { path: '/repo', cli: 'codex', mode: 'native' },
      message: 'work',
      cron: '* * * * * *',
      timezone: 'UTC'
    });

    now = new Date('2026-01-01T00:00:01.000Z');
    await service.tick();
    const first = service.listRuns(schedule.id)[0];
    runtime.statuses.set(first.sessionId as string, 'idle');
    now = new Date('2026-01-01T00:00:02.000Z');
    await service.tick();
    const runs = service.listRuns(schedule.id);

    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.sessionId)).size).toBe(2);
    expect(new Set(runs.map((run) => run.taskId)).size).toBe(2);
  });

  it('survives a worker restart and recovers a stale starting run', async () => {
    const schedule = service.createSchedule({
      name: 'restart-safe worker',
      newSession: { path: '/repo', cli: 'codex', mode: 'native' },
      message: 'work',
      cron: '* * * * * *',
      timezone: 'UTC'
    });
    const run = store.createRun(schedule.id, 'manual-recovery', 'waiting', now) as NonNullable<ReturnType<typeof store.createRun>>;
    expect(store.claimWaitingRun(run.id, now)?.status).toBe('starting');

    now = new Date(now.getTime() + 301_000);
    const restarted = new AutomationService(store, runtime, {
      workerId: 'restarted-worker', cleanupHours: 0, now: () => now, sleep: async () => {}
    });
    await restarted.tick();

    const recovered = restarted.getRun(run.id);
    expect(recovered?.status).toBe('running');
    expect(recovered?.sessionId).toMatch(/^run-/);
    expect(runtime.sent.filter((entry) => entry.body === 'work')).toHaveLength(1);
  });

  it('pauses, resumes, deletes, and runs a schedule immediately', async () => {
    const session = runtime.makeSession('mayor-mid', 'task-mayor');
    runtime.sessions.set(session.championId, session);
    runtime.statuses.set(session.championId, 'idle');
    const schedule = await service.createSessionSchedule({
      name: 'controlled wake', targetSessionId: session.championId, message: 'wake',
      cron: '* * * * * *', timezone: 'UTC'
    });

    expect(service.pauseSchedule(schedule.id).status).toBe('paused');
    now = new Date('2026-01-01T00:00:02.000Z');
    await service.tick();
    expect(service.listRuns(schedule.id)).toEqual([]);
    expect(service.resumeSchedule(schedule.id).status).toBe('active');
    const manual = await service.runScheduleNow(schedule.id);
    expect(manual.status).toBe('running');
    expect(service.deleteSchedule(schedule.id).status).toBe('deleted');
    expect(service.listRuns(schedule.id).map((run) => run.id)).toContain(manual.id);
  });

  it('marks an ambiguous send failure as delivery uncertain and does not retry it', async () => {
    const session = runtime.makeSession('mayor-mid', 'task-mayor');
    runtime.sessions.set(session.championId, session);
    runtime.statuses.set(session.championId, 'idle');
    runtime.sendError = new Error('connection reset after write');
    const message = service.enqueueMessage(session.championId, 'work');

    await service.tick();
    expect(service.getMessage(message.id)?.status).toBe('delivery_uncertain');
    await service.tick();
    expect(service.getMessage(message.id)?.attempts).toBe(1);
  });

  it('automatically retires old idle registry entries but preserves the task record', async () => {
    service = new AutomationService(store, runtime, {
      workerId: 'test-worker',
      cleanupHours: 24,
      cleanupIntervalMs: 0,
      now: () => now,
      sleep: async () => {}
    });
    const old = runtime.makeSession('old-worker', 'task-old', '/repo', '2025-12-01T00:00:00.000Z');
    runtime.sessions.set(old.championId, old);
    runtime.statuses.set(old.championId, 'idle');
    await service.createSessionSchedule({
      name: 'resume after cleanup',
      targetSessionId: old.championId,
      message: 'wake',
      cron: '0 * * * *',
      timezone: 'UTC'
    });

    await service.tick();
    expect(runtime.retired).toEqual(['old-worker']);
    expect(service.getRetiredSession('task-old')?.session.internalId).toBe('task-old');
  });
});
