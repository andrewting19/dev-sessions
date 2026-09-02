import { SessionCli, SessionMode, StoredSession } from '../types';

export type MessageStatus =
  | 'waiting'
  | 'dispatching'
  | 'delivered'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'delivery_uncertain';

export const TERMINAL_MESSAGE_STATUSES = new Set<MessageStatus>([
  'completed',
  'failed',
  'cancelled'
]);

export interface QueuedMessage {
  id: string;
  targetSessionId: string;
  sourceSessionId?: string;
  idempotencyKey?: string;
  correlationId: string;
  replyToMessageId?: string;
  sequence: number;
  body: string;
  status: MessageStatus;
  backendDeliveryId?: string;
  result?: string;
  error?: string;
  attempts: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  completedAt?: string;
  leaseOwner?: string;
  leaseUntil?: string;
}

export type ScheduleStatus = 'active' | 'paused' | 'deleted';
export type ScheduleTargetKind = 'session' | 'new-session';
export type ScheduleMisfirePolicy = 'latest' | 'skip';
export type ScheduleOverlapPolicy = 'skip' | 'queue';

export interface NewSessionTemplate {
  path: string;
  cli: SessionCli;
  mode: SessionMode;
  model?: string;
  description?: string;
}

export interface Schedule {
  id: string;
  name: string;
  status: ScheduleStatus;
  targetKind: ScheduleTargetKind;
  targetSessionId?: string;
  targetTaskId?: string;
  newSession?: NewSessionTemplate;
  message: string;
  cron: string;
  timezone: string;
  misfirePolicy: ScheduleMisfirePolicy;
  overlapPolicy: ScheduleOverlapPolicy;
  maxLatenessMs: number;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleRunStatus =
  | 'waiting'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  status: ScheduleRunStatus;
  sessionId?: string;
  taskId?: string;
  messageId?: string;
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RetiredSession {
  taskId: string;
  session: StoredSession;
  retiredAt: string;
}

export interface EnqueueMessageOptions {
  sourceSessionId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  replyToMessageId?: string;
  availableAt?: string;
}

export interface CreateScheduleOptions {
  name: string;
  targetSessionId?: string;
  newSession?: NewSessionTemplate;
  message: string;
  cron: string;
  timezone?: string;
  misfirePolicy?: ScheduleMisfirePolicy;
  overlapPolicy?: ScheduleOverlapPolicy;
  maxLatenessMs?: number;
  // Routing-only destination. The schedule is stored on this host, not in the
  // local database.
  host?: string;
}
