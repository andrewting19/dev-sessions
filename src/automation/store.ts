import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  CreateScheduleOptions,
  EnqueueMessageOptions,
  MessageStatus,
  QueuedMessage,
  RetiredSession,
  Schedule,
  ScheduleRun,
  ScheduleRunStatus,
  ScheduleStatus
} from './types';
import { StoredSession } from '../types';

const DEFAULT_MAX_LATENESS_MS = 60 * 60 * 1000;

export function resolveAutomationDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DEV_SESSIONS_STATE_PATH;
  if (configured && configured.trim().length > 0) return path.resolve(configured);
  return path.join(os.homedir(), '.dev-sessions', 'state.sqlite');
}

function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

interface MessageRow {
  id: string;
  target_session_id: string;
  source_session_id: string | null;
  idempotency_key: string | null;
  correlation_id: string;
  reply_to_message_id: string | null;
  sequence: number;
  body: string;
  status: MessageStatus;
  backend_delivery_id: string | null;
  result_text: string | null;
  error_text: string | null;
  attempts: number;
  available_at: string;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  completed_at: string | null;
  lease_owner: string | null;
  lease_until: string | null;
}

interface ScheduleRow {
  id: string;
  name: string;
  status: ScheduleStatus;
  target_kind: 'session' | 'new-session';
  target_session_id: string | null;
  target_task_id: string | null;
  new_session_json: string | null;
  message: string;
  cron: string;
  timezone: string;
  misfire_policy: 'latest' | 'skip';
  overlap_policy: 'skip' | 'queue';
  max_lateness_ms: number;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  schedule_id: string;
  scheduled_for: string;
  status: ScheduleRunStatus;
  session_id: string | null;
  task_id: string | null;
  message_id: string | null;
  result_text: string | null;
  error_text: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function mapMessage(row: MessageRow): QueuedMessage {
  return {
    id: row.id,
    targetSessionId: row.target_session_id,
    sourceSessionId: optional(row.source_session_id),
    idempotencyKey: optional(row.idempotency_key),
    correlationId: row.correlation_id,
    replyToMessageId: optional(row.reply_to_message_id),
    sequence: row.sequence,
    body: row.body,
    status: row.status,
    backendDeliveryId: optional(row.backend_delivery_id),
    result: optional(row.result_text),
    error: optional(row.error_text),
    attempts: row.attempts,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: optional(row.delivered_at),
    completedAt: optional(row.completed_at),
    leaseOwner: optional(row.lease_owner),
    leaseUntil: optional(row.lease_until)
  };
}

function mapSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    targetKind: row.target_kind,
    targetSessionId: optional(row.target_session_id),
    targetTaskId: optional(row.target_task_id),
    newSession: row.new_session_json ? JSON.parse(row.new_session_json) : undefined,
    message: row.message,
    cron: row.cron,
    timezone: row.timezone,
    misfirePolicy: row.misfire_policy,
    overlapPolicy: row.overlap_policy,
    maxLatenessMs: row.max_lateness_ms,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRun(row: RunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    sessionId: optional(row.session_id),
    taskId: optional(row.task_id),
    messageId: optional(row.message_id),
    result: optional(row.result_text),
    error: optional(row.error_text),
    createdAt: row.created_at,
    startedAt: optional(row.started_at),
    completedAt: optional(row.completed_at)
  };
}

export class AutomationStore {
  private readonly db: Database.Database;

  constructor(databasePath: string = resolveAutomationDatabasePath()) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 10000');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  enqueueMessage(targetSessionId: string, body: string, options: EnqueueMessageOptions = {}): QueuedMessage {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      if (options.idempotencyKey) {
        const existing = this.db.prepare(
          'SELECT * FROM messages WHERE target_session_id = ? AND idempotency_key = ?'
        ).get(targetSessionId, options.idempotencyKey) as MessageRow | undefined;
        if (existing) {
          return mapMessage(existing);
        }
      }

      const current = this.db.prepare(
        'SELECT next_sequence FROM message_sequences WHERE target_session_id = ?'
      ).get(targetSessionId) as { next_sequence: number } | undefined;
      const sequence = current?.next_sequence ?? 1;
      this.db.prepare(`
        INSERT INTO message_sequences(target_session_id, next_sequence)
        VALUES (?, ?)
        ON CONFLICT(target_session_id) DO UPDATE SET next_sequence = excluded.next_sequence
      `).run(targetSessionId, sequence + 1);

      const id = `msg_${randomUUID()}`;
      const correlationId = options.correlationId ?? options.replyToMessageId ?? id;
      this.db.prepare(`
        INSERT INTO messages(
          id, target_session_id, source_session_id, idempotency_key, correlation_id,
          reply_to_message_id, sequence, body, status, attempts, available_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ?, ?)
      `).run(
        id,
        targetSessionId,
        options.sourceSessionId ?? null,
        options.idempotencyKey ?? null,
        correlationId,
        options.replyToMessageId ?? null,
        sequence,
        body,
        options.availableAt ?? now,
        now,
        now
      );
      return this.getMessageRequired(id);
    });
    return transaction();
  }

  getMessage(id: string): QueuedMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  listMessages(options: { targetSessionId?: string; statuses?: MessageStatus[]; limit?: number } = {}): QueuedMessage[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.targetSessionId) {
      clauses.push('target_session_id = ?');
      params.push(options.targetSessionId);
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
      params.push(...options.statuses);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, options.limit ?? 100);
    const rows = this.db.prepare(
      `SELECT * FROM messages ${where} ORDER BY created_at DESC, sequence DESC LIMIT ?`
    ).all(...params, limit) as MessageRow[];
    return rows.map(mapMessage);
  }

  listInFlightMessages(): QueuedMessage[] {
    const rows = this.db.prepare(
      "SELECT * FROM messages WHERE status IN ('dispatching', 'delivered', 'delivery_uncertain') ORDER BY created_at"
    ).all() as MessageRow[];
    return rows.map(mapMessage);
  }

  listTargetSessionIdsWithOpenMessages(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT target_session_id FROM messages
      WHERE status NOT IN ('completed', 'failed', 'cancelled')
    `).all() as Array<{ target_session_id: string }>;
    return rows.map((row) => row.target_session_id);
  }

  claimDispatchableMessages(workerId: string, leaseMs: number, now: Date = new Date()): QueuedMessage[] {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const transaction = this.db.transaction(() => {
      const candidates = this.db.prepare(`
        SELECT m.* FROM messages m
        WHERE m.status = 'waiting'
          AND m.available_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM messages active
            WHERE active.target_session_id = m.target_session_id
              AND active.status IN ('dispatching', 'delivered', 'delivery_uncertain')
          )
          AND NOT EXISTS (
            SELECT 1 FROM messages earlier
            WHERE earlier.target_session_id = m.target_session_id
              AND earlier.sequence < m.sequence
              AND earlier.status IN ('waiting', 'dispatching', 'delivered', 'delivery_uncertain')
          )
        ORDER BY m.created_at, m.sequence
      `).all(nowIso) as MessageRow[];

      const claimed: QueuedMessage[] = [];
      for (const candidate of candidates) {
        const update = this.db.prepare(`
          UPDATE messages
          SET status = 'dispatching', attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
          WHERE id = ? AND status = 'waiting'
        `).run(workerId, leaseUntil, nowIso, candidate.id);
        if (update.changes === 1) {
          claimed.push(this.getMessageRequired(candidate.id));
        }
      }
      return claimed;
    });
    return transaction();
  }

  markMessageDelivered(id: string, backendDeliveryId?: string, now: Date = new Date()): QueuedMessage {
    const timestamp = now.toISOString();
    this.db.prepare(`
      UPDATE messages SET status = 'delivered', backend_delivery_id = ?, delivered_at = ?,
        updated_at = ?, lease_owner = NULL, lease_until = NULL, error_text = NULL
      WHERE id = ? AND status IN ('dispatching', 'delivery_uncertain')
    `).run(backendDeliveryId ?? null, timestamp, timestamp, id);
    return this.getMessageRequired(id);
  }

  markMessageDeliveryUncertain(id: string, error: string, now: Date = new Date()): QueuedMessage {
    const timestamp = now.toISOString();
    this.db.prepare(`
      UPDATE messages SET status = 'delivery_uncertain', error_text = ?, updated_at = ?,
        lease_owner = NULL, lease_until = NULL
      WHERE id = ? AND status = 'dispatching'
    `).run(error, timestamp, id);
    return this.getMessageRequired(id);
  }

  deferMessage(id: string, delayMs: number, now: Date = new Date()): QueuedMessage {
    const timestamp = now.toISOString();
    const availableAt = new Date(now.getTime() + Math.max(1, delayMs)).toISOString();
    this.db.prepare(`
      UPDATE messages SET status = 'waiting', available_at = ?, updated_at = ?,
        lease_owner = NULL, lease_until = NULL
      WHERE id = ? AND status = 'dispatching'
    `).run(availableAt, timestamp, id);
    return this.getMessageRequired(id);
  }

  markMessageTerminal(
    id: string,
    status: Extract<MessageStatus, 'completed' | 'failed' | 'cancelled'>,
    details: { result?: string; error?: string } = {},
    now: Date = new Date()
  ): QueuedMessage {
    const timestamp = now.toISOString();
    this.db.prepare(`
      UPDATE messages SET status = ?, result_text = ?, error_text = ?, completed_at = ?,
        updated_at = ?, lease_owner = NULL, lease_until = NULL
      WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
    `).run(status, details.result ?? null, details.error ?? null, timestamp, timestamp, id);
    return this.getMessageRequired(id);
  }

  markExpiredDispatchesUncertain(now: Date = new Date()): number {
    const timestamp = now.toISOString();
    return this.db.prepare(`
      UPDATE messages SET status = 'delivery_uncertain', updated_at = ?, lease_owner = NULL, lease_until = NULL
      WHERE status = 'dispatching' AND lease_until < ?
    `).run(timestamp, timestamp).changes;
  }

  retryMessage(id: string, now: Date = new Date()): QueuedMessage {
    const timestamp = now.toISOString();
    this.db.prepare(`
      UPDATE messages SET status = 'waiting', available_at = ?, updated_at = ?, error_text = NULL,
        lease_owner = NULL, lease_until = NULL
      WHERE id = ? AND status IN ('failed', 'cancelled', 'delivery_uncertain')
    `).run(timestamp, timestamp, id);
    return this.getMessageRequired(id);
  }

  createSchedule(options: CreateScheduleOptions, nextRunAt: Date, targetTaskId?: string): Schedule {
    const now = new Date().toISOString();
    const id = `sch_${randomUUID()}`;
    const targetKind = options.targetSessionId ? 'session' : 'new-session';
    this.db.prepare(`
      INSERT INTO schedules(
        id, name, status, target_kind, target_session_id, target_task_id, new_session_json, message,
        cron, timezone, misfire_policy, overlap_policy, max_lateness_ms,
        next_run_at, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      options.name,
      targetKind,
      options.targetSessionId ?? null,
      targetTaskId ?? null,
      options.newSession ? JSON.stringify(options.newSession) : null,
      options.message,
      options.cron,
      options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      options.misfirePolicy ?? 'latest',
      options.overlapPolicy ?? 'skip',
      options.maxLatenessMs ?? DEFAULT_MAX_LATENESS_MS,
      nextRunAt.toISOString(),
      now,
      now
    );
    return this.getScheduleRequired(id);
  }

  getSchedule(id: string): Schedule | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    return row ? mapSchedule(row) : undefined;
  }

  listSchedules(includeDeleted: boolean = false): Schedule[] {
    const rows = this.db.prepare(
      `SELECT * FROM schedules ${includeDeleted ? '' : "WHERE status != 'deleted'"} ORDER BY created_at DESC`
    ).all() as ScheduleRow[];
    return rows.map(mapSchedule);
  }

  listDueSchedules(now: Date = new Date()): Schedule[] {
    const rows = this.db.prepare(
      "SELECT * FROM schedules WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at"
    ).all(now.toISOString()) as ScheduleRow[];
    return rows.map(mapSchedule);
  }

  updateScheduleNextRun(id: string, nextRunAt: Date, now: Date = new Date()): Schedule {
    this.db.prepare('UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(nextRunAt.toISOString(), now.toISOString(), id);
    return this.getScheduleRequired(id);
  }

  updateScheduleTarget(id: string, targetSessionId: string, targetTaskId: string, now: Date = new Date()): Schedule {
    this.db.prepare(`
      UPDATE schedules SET target_session_id = ?, target_task_id = ?, updated_at = ? WHERE id = ?
    `).run(targetSessionId, targetTaskId, now.toISOString(), id);
    return this.getScheduleRequired(id);
  }

  setScheduleStatus(id: string, status: ScheduleStatus, now: Date = new Date()): Schedule {
    this.db.prepare('UPDATE schedules SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now.toISOString(), id);
    return this.getScheduleRequired(id);
  }

  createRun(
    scheduleId: string,
    scheduledFor: string,
    status: ScheduleRunStatus = 'waiting',
    now: Date = new Date()
  ): ScheduleRun | undefined {
    const id = `run_${randomUUID()}`;
    const createdAt = now.toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO schedule_runs(id, schedule_id, scheduled_for, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, scheduleId, scheduledFor, status, createdAt);
    if (result.changes === 0) {
      return undefined;
    }
    return this.getRunRequired(id);
  }

  advanceScheduleAndCreateRun(
    schedule: Schedule,
    scheduledFor: string,
    nextRunAt: Date,
    status: ScheduleRunStatus,
    now: Date = new Date()
  ): ScheduleRun | undefined {
    const transaction = this.db.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE schedules SET next_run_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND next_run_at = ?
      `).run(nextRunAt.toISOString(), now.toISOString(), schedule.id, schedule.nextRunAt);
      if (updated.changes !== 1) return undefined;

      let runStatus = status;
      if (runStatus === 'waiting' && schedule.overlapPolicy === 'skip' && this.hasActiveRun(schedule.id)) {
        runStatus = 'skipped';
      }
      return this.createRun(schedule.id, scheduledFor, runStatus, now);
    });
    return transaction();
  }

  listWaitingRuns(limit: number = 1000): ScheduleRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM schedule_runs WHERE status = 'waiting' ORDER BY created_at, scheduled_for LIMIT ?"
    ).all(Math.max(1, limit)) as RunRow[];
    return rows.map(mapRun);
  }

  claimWaitingRun(id: string, now: Date = new Date()): ScheduleRun | undefined {
    const transaction = this.db.transaction(() => {
      const candidate = this.getRun(id);
      if (!candidate || candidate.status !== 'waiting') return undefined;
      const earlier = this.db.prepare(`
        SELECT 1 AS found FROM schedule_runs
        WHERE schedule_id = ? AND id != ?
          AND (status IN ('starting', 'running') OR (status = 'waiting' AND created_at < ?))
        LIMIT 1
      `).get(candidate.scheduleId, id, candidate.createdAt) as { found: number } | undefined;
      if (earlier) return undefined;
      const updated = this.db.prepare(`
        UPDATE schedule_runs SET status = 'starting', started_at = ?
        WHERE id = ? AND status = 'waiting'
      `).run(now.toISOString(), id);
      return updated.changes === 1 ? this.getRunRequired(id) : undefined;
    });
    return transaction();
  }

  recoverExpiredStartingRuns(cutoff: Date): number {
    return this.db.prepare(`
      UPDATE schedule_runs SET status = 'waiting', started_at = NULL
      WHERE status = 'starting' AND started_at < ?
    `).run(cutoff.toISOString()).changes;
  }

  updateRun(
    id: string,
    update: Partial<Pick<ScheduleRun, 'status' | 'sessionId' | 'taskId' | 'messageId' | 'result' | 'error' | 'startedAt' | 'completedAt'>>
  ): ScheduleRun {
    const current = this.getRunRequired(id);
    const merged = { ...current, ...update };
    this.db.prepare(`
      UPDATE schedule_runs SET status = ?, session_id = ?, task_id = ?, message_id = ?,
        result_text = ?, error_text = ?, started_at = ?, completed_at = ? WHERE id = ?
    `).run(
      merged.status,
      merged.sessionId ?? null,
      merged.taskId ?? null,
      merged.messageId ?? null,
      merged.result ?? null,
      merged.error ?? null,
      merged.startedAt ?? null,
      merged.completedAt ?? null,
      id
    );
    return this.getRunRequired(id);
  }

  getRun(id: string): ScheduleRun | undefined {
    const row = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  listRuns(scheduleId?: string, limit: number = 100): ScheduleRun[] {
    const rows = scheduleId
      ? this.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(scheduleId, Math.max(1, limit)) as RunRow[]
      : this.db.prepare('SELECT * FROM schedule_runs ORDER BY created_at DESC LIMIT ?')
        .all(Math.max(1, limit)) as RunRow[];
    return rows.map(mapRun);
  }

  hasActiveRun(scheduleId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 AS found FROM schedule_runs WHERE schedule_id = ? AND status IN ('waiting', 'starting', 'running') LIMIT 1"
    ).get(scheduleId) as { found: number } | undefined;
    return row !== undefined;
  }

  findRunByMessage(messageId: string): ScheduleRun | undefined {
    const row = this.db.prepare('SELECT * FROM schedule_runs WHERE message_id = ?')
      .get(messageId) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  retireSession(session: StoredSession, now: Date = new Date()): RetiredSession {
    const retiredAt = now.toISOString();
    this.db.prepare(`
      INSERT INTO retired_sessions(task_id, session_json, retired_at)
      VALUES (?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET session_json = excluded.session_json, retired_at = excluded.retired_at
    `).run(session.internalId, JSON.stringify(session), retiredAt);
    return { taskId: session.internalId, session, retiredAt };
  }

  getRetiredSession(taskId: string): RetiredSession | undefined {
    const row = this.db.prepare('SELECT * FROM retired_sessions WHERE task_id = ?')
      .get(taskId) as { task_id: string; session_json: string; retired_at: string } | undefined;
    if (!row) return undefined;
    return {
      taskId: row.task_id,
      session: JSON.parse(row.session_json) as StoredSession,
      retiredAt: row.retired_at
    };
  }

  deleteRetiredSession(taskId: string): void {
    this.db.prepare('DELETE FROM retired_sessions WHERE task_id = ?').run(taskId);
  }

  claimMaintenance(key: string, intervalMs: number, now: Date = new Date()): boolean {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT value FROM service_state WHERE key = ?')
        .get(key) as { value: string } | undefined;
      if (row) {
        const lastRun = Date.parse(row.value);
        if (Number.isFinite(lastRun) && now.getTime() - lastRun < intervalMs) return false;
      }
      this.db.prepare(`
        INSERT INTO service_state(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, now.toISOString());
      return true;
    });
    return transaction();
  }

  private getMessageRequired(id: string): QueuedMessage {
    const message = this.getMessage(id);
    if (!message) throw new Error(`Message not found: ${id}`);
    return message;
  }

  private getScheduleRequired(id: string): Schedule {
    const schedule = this.getSchedule(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    return schedule;
  }

  private getRunRequired(id: string): ScheduleRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        target_session_id TEXT NOT NULL,
        source_session_id TEXT,
        idempotency_key TEXT,
        correlation_id TEXT NOT NULL,
        reply_to_message_id TEXT,
        sequence INTEGER NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        backend_delivery_id TEXT,
        result_text TEXT,
        error_text TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        completed_at TEXT,
        lease_owner TEXT,
        lease_until TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_target_sequence
        ON messages(target_session_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency
        ON messages(target_session_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_dispatch
        ON messages(status, available_at, target_session_id, sequence);
      CREATE TABLE IF NOT EXISTS message_sequences (
        target_session_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_session_id TEXT,
        target_task_id TEXT,
        new_session_json TEXT,
        message TEXT NOT NULL,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        misfire_policy TEXT NOT NULL,
        overlap_policy TEXT NOT NULL,
        max_lateness_ms INTEGER NOT NULL,
        next_run_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        message_id TEXT,
        result_text TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(schedule_id, scheduled_for),
        FOREIGN KEY(schedule_id) REFERENCES schedules(id)
      );
      CREATE INDEX IF NOT EXISTS schedule_runs_message ON schedule_runs(message_id);
      CREATE TABLE IF NOT EXISTS retired_sessions (
        task_id TEXT PRIMARY KEY,
        session_json TEXT NOT NULL,
        retired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }
}
