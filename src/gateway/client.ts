import path from 'node:path';
import { AgentTurnStatus, GoalUpdate, SessionCli, SessionMode, SessionTurn, StoredSession, ThreadGoal, WaitResult } from '../types';
import type { ResumeSessionOptions } from '../session-manager';
import type { MessageWaitResult } from '../automation/service';
import type {
  CreateScheduleOptions,
  EnqueueMessageOptions,
  MessageStatus,
  QueuedMessage,
  Schedule,
  ScheduleRun
} from '../automation/types';
import { TERMINAL_MESSAGE_STATUSES } from '../automation/types';

const DEFAULT_GATEWAY_BASE_URL = 'http://host.docker.internal:6767';
const DEFAULT_CONTAINER_WORKSPACE = '/workspace';

interface CreateSessionOptions {
  path?: string;
  description?: string;
  cli?: SessionCli;
  mode?: SessionMode;
  model?: string;
  host?: string;
}

interface WaitOptions {
  timeoutSeconds?: number;
  intervalSeconds?: number;
}

interface GatewayClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

interface CreateGatewayResponse {
  sessionId: string;
  session?: StoredSession;
}

interface ListGatewayResponse {
  sessions: StoredSession[];
}

interface LastMessageGatewayResponse {
  blocks: string[];
}

interface StatusGatewayResponse {
  status: AgentTurnStatus;
}

interface WaitGatewayResponse {
  waitResult: WaitResult;
}

function isAgentTurnStatus(value: string): value is AgentTurnStatus {
  return value === 'idle' || value === 'working' || value === 'waiting_for_input';
}

export function resolveGatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawUrl = env.DEV_SESSIONS_GATEWAY_URL;
  if (typeof rawUrl === 'string' && rawUrl.trim().length > 0) {
    return rawUrl.trim();
  }

  return DEFAULT_GATEWAY_BASE_URL;
}

/**
 * Translate a container-local path to the corresponding host path.
 * Inside Docker, /workspace maps to HOST_PATH on the host. An agent that passes
 * --path /workspace/subdir needs that translated to HOST_PATH/subdir before the
 * gateway forwards the command to the host.
 */
export function translateContainerPath(
  containerPath: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.DEV_SESSIONS_SANDBOX !== '1') {
    return containerPath;
  }

  const containerWorkspace = (env.CONTAINER_WORKSPACE ?? DEFAULT_CONTAINER_WORKSPACE).replace(/\/+$/, '');
  const resolved = path.resolve(containerPath);
  const targetsWorkspace =
    resolved === containerWorkspace || resolved.startsWith(containerWorkspace + '/');

  if (!targetsWorkspace) {
    return containerPath;
  }

  const hostPath = env.HOST_PATH;
  if (typeof hostPath !== 'string' || hostPath.trim().length === 0) {
    throw new Error(
      `HOST_PATH is required when running in sandbox mode with ${containerWorkspace} paths (received ${resolved})`
    );
  }

  if (resolved === containerWorkspace) {
    return hostPath;
  }

  if (resolved.startsWith(containerWorkspace + '/')) {
    return path.join(hostPath, resolved.slice(containerWorkspace.length));
  }

  return containerPath;
}

/**
 * Turn a gateway error envelope into an Error that carries the host CLI's own
 * stderr and exit code. Without this, every relayed failure collapses to the
 * bare "Command failed: <host cmd>" line and is undiagnosable from a container.
 */
export function buildGatewayError(payload: Record<string, unknown>, fallback: string): Error & { exitCode?: number } {
  const envelopeError = typeof payload.error === 'string' && payload.error.length > 0 ? payload.error : fallback;
  const output = payload.output as { stderr?: unknown; exitCode?: unknown } | undefined;
  const stderr = typeof output?.stderr === 'string' ? output.stderr.trim() : '';
  const exitCode = typeof output?.exitCode === 'number' ? output.exitCode : undefined;

  const message = stderr.length > 0 ? `${stderr}\n(${envelopeError})` : envelopeError;
  const error = new Error(message) as Error & { exitCode?: number };
  if (exitCode !== undefined && exitCode !== 0) {
    error.exitCode = exitCode;
  }
  return error;
}

export class GatewaySessionManager {
  private readonly baseUrl: string;

  private readonly fetchFn: typeof fetch;

  constructor(options: GatewayClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? resolveGatewayBaseUrl()).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async createSession(options: CreateSessionOptions): Promise<StoredSession> {
    const payload: Record<string, unknown> = {
      cli: options.cli ?? 'claude',
      mode: options.mode ?? 'native'
    };

    if (options.host !== undefined) {
      // Remote-host paths are interpreted on that host — no container translation,
      // and no default: an unset path resolves on the remote.
      payload.host = options.host;
      if (options.path !== undefined) {
        payload.path = options.path;
      }
    } else {
      payload.path = translateContainerPath(path.resolve(options.path ?? process.cwd()));
    }

    if (typeof options.description === 'string' && options.description.trim().length > 0) {
      payload.description = options.description;
    }
    if (typeof options.model === 'string' && options.model.trim().length > 0) {
      payload.model = options.model;
    }

    const response = await this.request<CreateGatewayResponse>('/create', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (response.session) {
      return response.session;
    }

    const listResponse = await this.request<ListGatewayResponse>('/list');
    const resolved = listResponse.sessions.find((candidate) => candidate.championId === response.sessionId);
    if (resolved) {
      return resolved;
    }

    const timestamp = new Date().toISOString();
    return {
      championId: response.sessionId,
      internalId: response.sessionId,
      cli: (payload.cli as SessionCli) ?? 'claude',
      mode: (payload.mode as SessionMode) ?? 'native',
      path: typeof payload.path === 'string' ? payload.path : '',
      host: options.host,
      description: options.description,
      status: 'active',
      model: typeof payload.model === 'string' ? payload.model : undefined,
      createdAt: timestamp,
      lastUsed: timestamp
    };
  }

  async sendMessage(
    championId: string,
    message: string,
    options: EnqueueMessageOptions = {}
  ): Promise<QueuedMessage | undefined> {
    const response = await this.request<{ message?: QueuedMessage }>('/send', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: championId,
        message,
        sourceSessionId: options.sourceSessionId,
        idempotencyKey: options.idempotencyKey,
        replyToMessageId: options.replyToMessageId
      })
    });
    return response.message;
  }

  async resumeTask(options: ResumeSessionOptions): Promise<StoredSession> {
    const response = await this.request<{ session: StoredSession }>('/resume', {
      method: 'POST',
      body: JSON.stringify(options)
    });
    return response.session;
  }

  async listQueuedMessages(
    championId?: string,
    statuses?: MessageStatus[],
    limit: number = 100,
    host?: string
  ): Promise<QueuedMessage[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (championId) query.set('sessionId', championId);
    if (statuses && statuses.length > 0) query.set('status', statuses.join(','));
    if (host) query.set('host', host);
    const response = await this.request<{ messages: QueuedMessage[] }>(`/messages?${query.toString()}`);
    return response.messages;
  }

  async getQueuedMessage(id: string, routeSessionId?: string): Promise<QueuedMessage | undefined> {
    const query = new URLSearchParams({ id });
    if (routeSessionId) query.set('sessionId', routeSessionId);
    const response = await this.request<{ message: QueuedMessage | null }>(`/message?${query.toString()}`);
    return response.message ?? undefined;
  }

  async waitForQueuedMessage(id: string, options: WaitOptions = {}, routeSessionId?: string): Promise<MessageWaitResult> {
    const timeoutMs = Math.max(0.05, options.timeoutSeconds ?? 300) * 1000;
    const intervalMs = Math.max(0.05, options.intervalSeconds ?? 1) * 1000;
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const message = await this.getQueuedMessage(id, routeSessionId);
      if (!message) throw new Error(`Message not found: ${id}`);
      if (TERMINAL_MESSAGE_STATUSES.has(message.status)) {
        return { message, timedOut: false, elapsedMs: Date.now() - started };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, timeoutMs - (Date.now() - started))));
    }
    const message = await this.getQueuedMessage(id, routeSessionId);
    if (!message) throw new Error(`Message not found: ${id}`);
    return { message, timedOut: true, elapsedMs: Date.now() - started };
  }

  async cancelQueuedMessage(id: string, routeSessionId?: string): Promise<QueuedMessage> {
    return this.messageAction('cancel', id, routeSessionId);
  }

  async retryQueuedMessage(id: string, routeSessionId?: string): Promise<QueuedMessage> {
    return this.messageAction('retry', id, routeSessionId);
  }

  async replyToQueuedMessage(
    id: string,
    body: string,
    options: Pick<EnqueueMessageOptions, 'idempotencyKey'> = {},
    routeSessionId?: string
  ): Promise<QueuedMessage> {
    const response = await this.request<{ message: QueuedMessage }>('/message/reply', {
      method: 'POST',
      body: JSON.stringify({ id, body, routeSessionId, idempotencyKey: options.idempotencyKey })
    });
    return response.message;
  }

  async createSchedule(options: CreateScheduleOptions): Promise<Schedule> {
    const response = await this.request<{ schedule: Schedule }>('/schedule', {
      method: 'POST',
      body: JSON.stringify(options)
    });
    return response.schedule;
  }

  async listSchedules(host?: string): Promise<Schedule[]> {
    const query = new URLSearchParams();
    if (host) query.set('host', host);
    const response = await this.request<{ schedules: Schedule[] }>(`/schedules?${query.toString()}`);
    return response.schedules;
  }

  async getSchedule(id: string): Promise<Schedule | undefined> {
    const response = await this.request<{ schedule: Schedule | null }>(`/schedule?id=${encodeURIComponent(id)}`);
    return response.schedule ?? undefined;
  }

  async pauseSchedule(id: string): Promise<Schedule> {
    return this.scheduleAction('pause', id);
  }

  async resumeSchedule(id: string): Promise<Schedule> {
    return this.scheduleAction('resume', id);
  }

  async deleteSchedule(id: string): Promise<Schedule> {
    return this.scheduleAction('delete', id);
  }

  async runScheduleNow(id: string): Promise<ScheduleRun> {
    const response = await this.request<{ run: ScheduleRun }>('/schedule/run', {
      method: 'POST', body: JSON.stringify({ id })
    });
    return response.run;
  }

  async listScheduleRuns(scheduleId?: string, limit: number = 100, host?: string): Promise<ScheduleRun[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (scheduleId) query.set('scheduleId', scheduleId);
    if (host) query.set('host', host);
    const response = await this.request<{ runs: ScheduleRun[] }>(`/runs?${query.toString()}`);
    return response.runs;
  }

  async getScheduleRun(id: string): Promise<ScheduleRun | undefined> {
    const response = await this.request<{ run: ScheduleRun | null }>(`/run?id=${encodeURIComponent(id)}`);
    return response.run ?? undefined;
  }

  async runAutomationTick(): Promise<void> {
    await this.request('/automation/tick', { method: 'POST', body: '{}' });
  }

  private async messageAction(action: 'cancel' | 'retry', id: string, routeSessionId?: string): Promise<QueuedMessage> {
    const response = await this.request<{ message: QueuedMessage }>(`/message/${action}`, {
      method: 'POST', body: JSON.stringify({ id, routeSessionId })
    });
    return response.message;
  }

  private async scheduleAction(action: 'pause' | 'resume' | 'delete', id: string): Promise<Schedule> {
    const response = await this.request<{ schedule: Schedule }>(`/schedule/${action}`, {
      method: 'POST', body: JSON.stringify({ id })
    });
    return response.schedule;
  }

  async killSession(championId: string): Promise<void> {
    await this.request('/kill', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: championId
      })
    });
  }

  async listSessions(): Promise<StoredSession[]> {
    const response = await this.request<ListGatewayResponse>('/list');
    return response.sessions;
  }

  async getLastAssistantTextBlocks(championId: string, count: number): Promise<string[]> {
    const safeCount = Math.max(1, count);
    const query = new URLSearchParams({
      id: championId,
      n: String(safeCount)
    });
    const response = await this.request<LastMessageGatewayResponse>(`/last-message?${query.toString()}`);
    return response.blocks;
  }

  async getSessionStatus(championId: string): Promise<AgentTurnStatus> {
    const query = new URLSearchParams({
      id: championId
    });
    const response = await this.request<StatusGatewayResponse>(`/status?${query.toString()}`);
    if (!isAgentTurnStatus(response.status)) {
      throw new Error(`Gateway returned invalid status: ${String(response.status)}`);
    }

    return response.status;
  }

  async getSessionLogs(championId: string): Promise<SessionTurn[]> {
    const query = new URLSearchParams({ id: championId });
    const response = await this.request<{ logs: string }>(`/logs?${query.toString()}`);
    const raw = response.logs ?? '';
    const turns: SessionTurn[] = [];
    const blocks = raw.split(/\n\n(?=\[(HUMAN|ASSISTANT)\]\n)/);
    for (const block of blocks) {
      const match = /^\[(HUMAN|ASSISTANT)\]\n([\s\S]*)$/.exec(block.trim());
      if (match) {
        turns.push({
          role: match[1] === 'HUMAN' ? 'human' : 'assistant',
          text: match[2]
        });
      }
    }
    return turns;
  }

  async inspectSession(championId: string): Promise<StoredSession> {
    const query = new URLSearchParams({ id: championId });
    const response = await this.request<{ session: StoredSession }>(`/inspect?${query.toString()}`);
    return response.session;
  }

  async setSessionGoal(championId: string, update: GoalUpdate): Promise<ThreadGoal> {
    const payload: Record<string, unknown> = { sessionId: championId };
    if (update.objective !== undefined) {
      payload.objective = update.objective;
    }
    if (update.status !== undefined) {
      payload.status = update.status;
    }
    if (update.tokenBudget !== undefined && update.tokenBudget !== null) {
      payload.tokenBudget = update.tokenBudget;
    }

    const response = await this.request<{ goal: ThreadGoal }>('/goal', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return response.goal;
  }

  async getSessionGoal(championId: string): Promise<ThreadGoal | undefined> {
    const query = new URLSearchParams({ id: championId });
    const response = await this.request<{ goal: ThreadGoal | null }>(`/goal?${query.toString()}`);
    return response.goal ?? undefined;
  }

  async clearSessionGoal(championId: string): Promise<boolean> {
    const response = await this.request<{ cleared: boolean }>('/goal', {
      method: 'POST',
      body: JSON.stringify({ sessionId: championId, clear: true })
    });
    return response.cleared === true;
  }

  async waitForSessionGoal(
    championId: string,
    options: WaitOptions = {}
  ): Promise<{ goal?: ThreadGoal; timedOut: boolean; elapsedMs: number }> {
    const timeoutSeconds = Math.max(1, options.timeoutSeconds ?? 300);
    const query = new URLSearchParams({
      id: championId,
      timeout: String(timeoutSeconds),
      goal: '1'
    });

    if (typeof options.intervalSeconds === 'number' && Number.isFinite(options.intervalSeconds)) {
      query.set('interval', String(Math.max(1, options.intervalSeconds)));
    }

    const response = await this.waitRequest<WaitGatewayResponse & { goal?: ThreadGoal | null }>(
      `/wait?${query.toString()}`
    );
    return {
      goal: response.goal ?? undefined,
      timedOut: response.waitResult.timedOut,
      elapsedMs: response.waitResult.elapsedMs
    };
  }

  async waitForSessionNextTurn(championId: string, options: WaitOptions = {}): Promise<WaitResult> {
    const timeoutSeconds = Math.max(1, options.timeoutSeconds ?? 300);
    const query = new URLSearchParams({
      id: championId,
      timeout: String(timeoutSeconds),
      nextTurn: '1'
    });

    const response = await this.waitRequest<WaitGatewayResponse>(`/wait?${query.toString()}`);
    return response.waitResult;
  }

  async waitForSession(championId: string, options: WaitOptions = {}): Promise<WaitResult> {
    const timeoutSeconds = Math.max(1, options.timeoutSeconds ?? 300);
    const query = new URLSearchParams({
      id: championId,
      timeout: String(timeoutSeconds)
    });

    if (typeof options.intervalSeconds === 'number' && Number.isFinite(options.intervalSeconds)) {
      query.set('interval', String(Math.max(1, options.intervalSeconds)));
    }

    const response = await this.waitRequest<WaitGatewayResponse>(`/wait?${query.toString()}`);
    return response.waitResult;
  }

  private async waitRequest<T extends WaitGatewayResponse>(requestPath: string): Promise<T> {
    const response = await this.request<T>(requestPath);
    if (!response.waitResult || typeof response.waitResult.timedOut !== 'boolean') {
      throw new Error(
        'Gateway /wait response is missing waitResult (the gateway connection may have dropped mid-wait)'
      );
    }
    return response;
  }

  private async request<T>(
    requestPath: string,
    init: Omit<RequestInit, 'headers'> & { headers?: HeadersInit } = {}
  ): Promise<T> {
    const requestUrl = `${this.baseUrl}${requestPath}`;
    let response: Response;
    try {
      response = await this.fetchFn(requestUrl, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...init.headers
        }
      });
    } catch (error) {
      // Sandbox/Docker sessions use the local gateway HTTP bridge; unreachable gateway fetches fail as TypeError.
      if (error instanceof TypeError) {
        const hint = 'Is the gateway running? Start it with: dev-sessions gateway --port <port>';
        const detail = typeof error.message === 'string' && error.message.length > 0 ? ` (${error.message})` : '';
        throw new Error(`Gateway request failed for ${requestUrl}${detail}. ${hint}`);
      }

      throw error;
    }

    const rawBody = (await response.text()).trim();
    let payload: Record<string, unknown> = {};
    if (rawBody.length > 0) {
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        const preview = rawBody.slice(0, 200);
        throw new Error(
          `Gateway returned non-JSON response (status=${response.status}, url=${requestUrl}): ${preview}`
        );
      }
    }

    if (!response.ok) {
      throw buildGatewayError(payload, `Gateway request failed with status ${response.status}`);
    }

    // Streamed endpoints (/wait) commit a 200 status before the command runs, so a
    // failure after that point can only be reported via an ok:false body envelope.
    if (payload.ok === false) {
      throw buildGatewayError(payload, `Gateway request failed for ${requestUrl}`);
    }

    return payload as T;
  }
}
