import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { CreateSessionOptions, ResumeSessionOptions, WaitOptions } from '../session-manager';
import { AgentTurnStatus, StoredSession } from '../types';
import { AutomationStore } from './store';
import {
  CreateScheduleOptions,
  EnqueueMessageOptions,
  MessageStatus,
  QueuedMessage,
  RetiredSession,
  Schedule,
  ScheduleRun,
  TERMINAL_MESSAGE_STATUSES
} from './types';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BUSY_RETRY_MS = 1_000;
const DEFAULT_CLEANUP_HOURS = 48;
const DEFAULT_RUN_START_LEASE_MS = 5 * 60 * 1000;

export interface AutomationSessionRuntime {
  createSession(options: CreateSessionOptions): Promise<StoredSession>;
  resumeSession(options: ResumeSessionOptions): Promise<StoredSession>;
  retireSession(championId: string): Promise<StoredSession>;
  sendMessageDirect(championId: string, message: string): Promise<void>;
  getSessionStatus(championId: string): Promise<AgentTurnStatus>;
  getLastAssistantTextBlocks(championId: string, count: number): Promise<string[]>;
  waitForSession(championId: string, options?: WaitOptions): Promise<{ completed: boolean; timedOut: boolean }>;
  waitForDelivery?(
    championId: string,
    deliveryId: string,
    options?: WaitOptions
  ): Promise<{ completed: boolean; timedOut: boolean; result?: string }>;
  inspectSession(championId: string): Promise<StoredSession>;
  listSessions(): Promise<StoredSession[]>;
}

export interface AutomationServiceOptions {
  workerId?: string;
  leaseMs?: number;
  busyRetryMs?: number;
  cleanupHours?: number;
  cleanupIntervalMs?: number;
  runStartLeaseMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface MessageWaitResult {
  message: QueuedMessage;
  timedOut: boolean;
  elapsedMs: number;
}

function backendDeliveryId(session: StoredSession): string | undefined {
  return session.codexActiveTurnId ?? session.grokActivePromptId;
}

function isSessionNotFound(error: unknown): boolean {
  return error instanceof Error && /session not found/i.test(error.message);
}

export function nextCronRun(cron: string, timezone: string, after: Date): Date {
  const evaluator = new Cron(cron, { timezone, paused: true });
  const next = evaluator.nextRun(after);
  evaluator.stop();
  if (!next) {
    throw new Error(`Schedule has no future run: ${cron}`);
  }
  return next;
}

export function previousCronRun(cron: string, timezone: string, before: Date): Date | undefined {
  const evaluator = new Cron(cron, { timezone, paused: true });
  const previous = evaluator.previousRuns(1, before)[0];
  evaluator.stop();
  return previous ?? undefined;
}

export class AutomationService {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly busyRetryMs: number;
  private readonly cleanupHours: number;
  private readonly cleanupIntervalMs: number;
  private readonly runStartLeaseMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private ticking = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly runtime: AutomationSessionRuntime,
    options: AutomationServiceOptions = {}
  ) {
    this.workerId = options.workerId ?? `worker_${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.busyRetryMs = options.busyRetryMs ?? DEFAULT_BUSY_RETRY_MS;
    this.cleanupHours = options.cleanupHours ?? DEFAULT_CLEANUP_HOURS;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 60 * 1000;
    this.runStartLeaseMs = options.runStartLeaseMs ?? DEFAULT_RUN_START_LEASE_MS;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (async (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  enqueueMessage(targetSessionId: string, body: string, options: EnqueueMessageOptions = {}): QueuedMessage {
    return this.store.enqueueMessage(targetSessionId, body, {
      ...options,
      availableAt: options.availableAt ?? this.now().toISOString()
    });
  }

  getMessage(id: string): QueuedMessage | undefined {
    return this.store.getMessage(id);
  }

  reservedSessionIds(): string[] {
    return this.store.listTargetSessionIdsWithOpenMessages();
  }

  listMessages(targetSessionId?: string, statuses?: MessageStatus[], limit?: number): QueuedMessage[] {
    return this.store.listMessages({ targetSessionId, statuses, limit });
  }

  cancelMessage(id: string): QueuedMessage {
    const message = this.requireMessage(id);
    if (message.status !== 'waiting' && message.status !== 'delivery_uncertain') {
      throw new Error(`Message ${id} cannot be cancelled after delivery`);
    }
    return this.store.markMessageTerminal(id, 'cancelled');
  }

  retryMessage(id: string): QueuedMessage {
    return this.store.retryMessage(id, this.now());
  }

  replyToMessage(id: string, body: string, options: Pick<EnqueueMessageOptions, 'idempotencyKey'> = {}): QueuedMessage {
    const original = this.requireMessage(id);
    if (!original.sourceSessionId) {
      throw new Error(`Message ${id} has no source session to reply to`);
    }
    return this.enqueueMessage(original.sourceSessionId, body, {
      idempotencyKey: options.idempotencyKey,
      sourceSessionId: original.targetSessionId,
      correlationId: original.correlationId,
      replyToMessageId: original.id
    });
  }

  async waitForMessage(id: string, options: WaitOptions = {}): Promise<MessageWaitResult> {
    const timeoutMs = Math.max(0.05, options.timeoutSeconds ?? 300) * 1000;
    const intervalMs = Math.max(0.05, options.intervalSeconds ?? 1) * 1000;
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      await this.tick();
      const message = this.requireMessage(id);
      if (TERMINAL_MESSAGE_STATUSES.has(message.status)) {
        return { message, timedOut: false, elapsedMs: Date.now() - started };
      }
      await this.sleep(Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    return { message: this.requireMessage(id), timedOut: true, elapsedMs: Date.now() - started };
  }

  createSchedule(options: CreateScheduleOptions): Schedule {
    if ((options.targetSessionId ? 1 : 0) + (options.newSession ? 1 : 0) !== 1) {
      throw new Error('A schedule requires exactly one target session or new-session template');
    }
    const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const next = nextCronRun(options.cron, timezone, this.now());
    return this.store.createSchedule({ ...options, timezone }, next);
  }

  async createSessionSchedule(options: CreateScheduleOptions & { targetSessionId: string }): Promise<Schedule> {
    const session = await this.runtime.inspectSession(options.targetSessionId);
    const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const next = nextCronRun(options.cron, timezone, this.now());
    return this.store.createSchedule(
      { ...options, timezone, targetSessionId: session.championId },
      next,
      session.internalId
    );
  }

  getSchedule(id: string): Schedule | undefined {
    return this.store.getSchedule(id);
  }

  listSchedules(): Schedule[] {
    return this.store.listSchedules();
  }

  pauseSchedule(id: string): Schedule {
    return this.store.setScheduleStatus(id, 'paused', this.now());
  }

  resumeSchedule(id: string): Schedule {
    const schedule = this.requireSchedule(id);
    const next = nextCronRun(schedule.cron, schedule.timezone, this.now());
    this.store.updateScheduleNextRun(id, next, this.now());
    return this.store.setScheduleStatus(id, 'active', this.now());
  }

  deleteSchedule(id: string): Schedule {
    return this.store.setScheduleStatus(id, 'deleted', this.now());
  }

  async runScheduleNow(id: string): Promise<ScheduleRun> {
    const schedule = this.requireSchedule(id);
    if (schedule.status === 'deleted') {
      throw new Error(`Schedule is deleted: ${id}`);
    }
    const now = this.now();
    const run = this.store.createRun(schedule.id, `${now.toISOString()}#manual-${randomUUID()}`, 'waiting', now);
    if (!run) throw new Error(`Could not create a manual run for schedule ${id}`);
    await this.processWaitingRuns();
    return this.store.getRun(run.id) ?? run;
  }

  getRun(id: string): ScheduleRun | undefined {
    return this.store.getRun(id);
  }

  listRuns(scheduleId?: string, limit?: number): ScheduleRun[] {
    return this.store.listRuns(scheduleId, limit);
  }

  getRetiredSession(taskId: string): RetiredSession | undefined {
    return this.store.getRetiredSession(taskId);
  }

  rememberRetiredSession(session: StoredSession): RetiredSession {
    return this.store.retireSession(session, this.now());
  }

  async resumeTask(options: ResumeSessionOptions): Promise<StoredSession> {
    const retired = this.store.getRetiredSession(options.taskId);
    const session = await this.runtime.resumeSession({
      ...options,
      path: options.path ?? retired?.session.path,
      cli: options.cli ?? retired?.session.cli,
      mode: options.mode ?? retired?.session.mode,
      model: options.model ?? retired?.session.model,
      description: options.description ?? retired?.session.description
    });
    this.store.deleteRetiredSession(options.taskId);
    return session;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.store.markExpiredDispatchesUncertain(now);
      this.store.recoverExpiredStartingRuns(new Date(now.getTime() - this.runStartLeaseMs));
      await this.reconcileInFlight();
      await this.processDueSchedules();
      await this.processWaitingRuns();
      const claimed = this.store.claimDispatchableMessages(this.workerId, this.leaseMs, now);
      for (const message of claimed) {
        await this.dispatch(message);
      }
      await this.reconcileRuns();
      await this.cleanupSessions();
    } finally {
      this.ticking = false;
    }
  }

  private async reconcileInFlight(): Promise<void> {
    for (const message of this.store.listInFlightMessages()) {
      if (message.status === 'dispatching') continue;
      if (message.status === 'delivery_uncertain') {
        try {
          const session = await this.runtime.inspectSession(message.targetSessionId);
          const status = await this.runtime.getSessionStatus(message.targetSessionId);
          if (status === 'working' || status === 'waiting_for_input' || backendDeliveryId(session)) {
            this.store.markMessageDelivered(message.id, backendDeliveryId(session), this.now());
          }
        } catch {
          // Uncertain delivery requires an explicit retry or cancellation when
          // the backend does not provide evidence that it accepted the work.
        }
        continue;
      }

      try {
        const wait = await this.pollDeliveredMessage(message);
        if (!wait.completed) continue;
        this.store.markMessageTerminal(message.id, 'completed', { result: wait.result }, this.now());
      } catch (error: unknown) {
        this.store.markMessageTerminal(message.id, 'failed', {
          error: error instanceof Error ? error.message : String(error)
        }, this.now());
      }
    }
  }

  private async dispatch(message: QueuedMessage): Promise<void> {
    let deliveryAttempted = false;
    try {
      const status = await this.runtime.getSessionStatus(message.targetSessionId);
      if (status !== 'idle') {
        this.store.deferMessage(message.id, this.busyRetryMs, this.now());
        return;
      }

      deliveryAttempted = true;
      await this.runtime.sendMessageDirect(message.targetSessionId, message.body);
      const session = await this.runtime.inspectSession(message.targetSessionId);
      const delivered = this.store.markMessageDelivered(
        message.id,
        backendDeliveryId(session),
        this.now()
      );

      const wait = await this.pollDeliveredMessage(delivered);
      if (wait.completed) {
        this.store.markMessageTerminal(message.id, 'completed', { result: wait.result }, this.now());
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/already has a turn in progress|busy|working/i.test(detail)) {
        this.store.deferMessage(message.id, this.busyRetryMs, this.now());
        return;
      }
      if (/not found|invalid|unsupported|rejected|permission|denied/i.test(detail)) {
        this.store.markMessageTerminal(message.id, 'failed', { error: detail }, this.now());
        return;
      }
      if (!deliveryAttempted) {
        this.store.deferMessage(message.id, this.busyRetryMs, this.now());
        return;
      }
      this.store.markMessageDeliveryUncertain(message.id, detail, this.now());
    }
  }

  private async pollDeliveredMessage(
    message: QueuedMessage
  ): Promise<{ completed: boolean; result?: string }> {
    const options = { timeoutSeconds: 0.05, intervalSeconds: 0.05 };
    if (message.backendDeliveryId && this.runtime.waitForDelivery) {
      const wait = await this.runtime.waitForDelivery(
        message.targetSessionId,
        message.backendDeliveryId,
        options
      );
      return { completed: wait.completed, result: wait.result };
    }

    const wait = await this.runtime.waitForSession(message.targetSessionId, options);
    const result = wait.completed
      ? (await this.runtime.getLastAssistantTextBlocks(message.targetSessionId, 1))[0]
      : undefined;
    return { completed: wait.completed, result };
  }

  private async processDueSchedules(): Promise<void> {
    const now = this.now();
    for (const schedule of this.store.listDueSchedules(now)) {
      const next = nextCronRun(schedule.cron, schedule.timezone, now);
      const originalDue = new Date(schedule.nextRunAt);
      const missed = now.getTime() - originalDue.getTime() > 1_000;
      const latest = missed && schedule.misfirePolicy === 'latest'
        ? previousCronRun(schedule.cron, schedule.timezone, new Date(now.getTime() + 1_000))
        : undefined;
      const scheduledFor = (latest && latest > originalDue ? latest : originalDue).toISOString();
      const lateBy = now.getTime() - Date.parse(scheduledFor);
      const outsideTickWindow = lateBy > 1_000;
      const status = lateBy > schedule.maxLatenessMs ||
        (schedule.misfirePolicy === 'skip' && outsideTickWindow)
        ? 'skipped'
        : 'waiting';
      this.store.advanceScheduleAndCreateRun(schedule, scheduledFor, next, status, now);
    }
  }

  private async processWaitingRuns(): Promise<void> {
    for (const candidate of this.store.listWaitingRuns()) {
      const run = this.store.claimWaitingRun(candidate.id, this.now());
      if (!run) continue;
      const schedule = this.store.getSchedule(run.scheduleId);
      if (!schedule || schedule.status === 'deleted') {
        this.store.updateRun(run.id, {
          status: 'cancelled',
          completedAt: this.now().toISOString(),
          error: 'Schedule was deleted before the run started'
        });
        continue;
      }
      await this.startRun(schedule, run);
    }
  }

  private async startRun(schedule: Schedule, run: ScheduleRun): Promise<ScheduleRun> {
    const startedAt = this.now().toISOString();
    try {
      let session: StoredSession;
      if (schedule.targetKind === 'new-session') {
        if (!schedule.newSession) throw new Error(`Schedule ${schedule.id} has no new-session template`);
        const sessionId = run.sessionId ?? `run-${run.id.slice(4, 16)}`;
        this.store.updateRun(run.id, { sessionId, startedAt });
        try {
          session = await this.runtime.inspectSession(sessionId);
        } catch (error: unknown) {
          if (!isSessionNotFound(error)) throw error;
          session = await this.runtime.createSession({ ...schedule.newSession, championId: sessionId });
        }
      } else {
        if (!schedule.targetSessionId || !schedule.targetTaskId) {
          throw new Error(`Schedule ${schedule.id} has no resumable session target`);
        }
        const resumeId = run.sessionId ?? `run-${run.id.slice(4, 16)}`;
        this.store.updateRun(run.id, { sessionId: resumeId, startedAt });
        try {
          session = await this.runtime.inspectSession(schedule.targetSessionId);
        } catch (error: unknown) {
          if (!isSessionNotFound(error)) throw error;
          try {
            session = await this.runtime.inspectSession(resumeId);
          } catch (resumeError: unknown) {
            if (!isSessionNotFound(resumeError)) throw resumeError;
            session = await this.resumeTask({ taskId: schedule.targetTaskId, championId: resumeId });
          }
          this.store.updateScheduleTarget(schedule.id, session.championId, session.internalId, this.now());
        }
      }

      const message = this.enqueueMessage(session.championId, schedule.message, {
        idempotencyKey: `${schedule.id}:${run.scheduledFor}`,
        correlationId: run.id
      });
      return this.store.updateRun(run.id, {
        status: 'running',
        sessionId: session.championId,
        taskId: session.internalId,
        messageId: message.id,
        startedAt
      });
    } catch (error: unknown) {
      return this.store.updateRun(run.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: this.now().toISOString()
      });
    }
  }

  private async reconcileRuns(): Promise<void> {
    for (const run of this.store.listRuns(undefined, 1000)) {
      if (run.status !== 'running' || !run.messageId) continue;
      const message = this.store.getMessage(run.messageId);
      if (!message || !TERMINAL_MESSAGE_STATUSES.has(message.status)) continue;
      const status = message.status === 'completed'
        ? 'completed'
        : message.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
      this.store.updateRun(run.id, {
        status,
        result: message.result,
        error: message.error,
        completedAt: message.completedAt ?? this.now().toISOString()
      });
    }
  }

  private async cleanupSessions(): Promise<void> {
    if (this.cleanupHours <= 0) return;
    const nowMs = this.now().getTime();
    if (!this.store.claimMaintenance('session-cleanup', this.cleanupIntervalMs, new Date(nowMs))) return;
    const cutoff = nowMs - this.cleanupHours * 60 * 60 * 1000;
    const protectedSessionIds = new Set(this.store.listTargetSessionIdsWithOpenMessages());
    for (const session of await this.runtime.listSessions()) {
      if (protectedSessionIds.has(session.championId)) continue;
      const lastUsed = Date.parse(session.lastUsed);
      if (!Number.isFinite(lastUsed) || lastUsed >= cutoff) continue;
      try {
        const status = await this.runtime.getSessionStatus(session.championId);
        if (status !== 'idle') continue;
      } catch {
        continue;
      }
      this.store.retireSession(session, this.now());
      await this.runtime.retireSession(session.championId);
    }
  }

  private requireMessage(id: string): QueuedMessage {
    const message = this.store.getMessage(id);
    if (!message) throw new Error(`Message not found: ${id}`);
    return message;
  }

  private requireSchedule(id: string): Schedule {
    const schedule = this.store.getSchedule(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    return schedule;
  }
}
