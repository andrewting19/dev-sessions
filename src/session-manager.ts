import path from 'node:path';
import { stat } from 'node:fs/promises';
import { generateChampionId } from './champion-ids';
import { Backend } from './backends/backend';
import { ClaudeBackend } from './backends/claude-backend';
import { ClaudeTmuxBackend } from './backends/claude-tmux';
import { CodexBackend } from './backends/codex-backend';
import { CodexAppServerBackend } from './backends/codex-appserver';
import { GrokBackend } from './backends/grok-backend';
import { GrokAppServerBackend } from './backends/grok-appserver';
import { GatewaySessionManager, resolveGatewayBaseUrl } from './gateway/client';
import { RoutingSessionManager } from './remote/routing-manager';
import { SessionStore, createDefaultSessionStore } from './session-store';
import pkg from '../package.json';
import { AgentTurnStatus, GoalUpdate, SessionCli, SessionMode, SessionTurn, StoredSession, ThreadGoal, WaitResult } from './types';
import { AutomationService, MessageWaitResult } from './automation/service';
import { AutomationStore, resolveAutomationDatabasePath } from './automation/store';
import {
  CreateScheduleOptions,
  EnqueueMessageOptions,
  MessageStatus,
  QueuedMessage,
  Schedule,
  ScheduleRun
} from './automation/types';

export interface CreateSessionOptions {
  path?: string;
  description?: string;
  cli?: SessionCli;
  mode?: SessionMode;
  model?: string;
  // SSH target to create the session on (handled by RoutingSessionManager).
  host?: string;
  // Pre-allocated champion ID. Used by the remote relay so the orchestrator's
  // registry can guarantee IDs are unique across hosts.
  championId?: string;
}

export interface ResumeSessionOptions {
  taskId: string;
  path?: string;
  cli?: SessionCli;
  mode?: SessionMode;
  model?: string;
  description?: string;
  host?: string;
  championId?: string;
}

export interface WaitOptions {
  timeoutSeconds?: number;
  intervalSeconds?: number;
}

export interface GoalWaitResult {
  // Undefined when the goal was cleared while waiting.
  goal?: ThreadGoal;
  timedOut: boolean;
  elapsedMs: number;
}

const TERMINAL_GOAL_STATUSES: ReadonlySet<string> = new Set([
  'complete',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited'
]);

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  limit: number,
  transform: (value: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await transform(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class SessionManager {
  private readonly backends: Map<SessionCli, Backend>;
  private automation?: AutomationService;

  constructor(
    private readonly store: SessionStore,
    claudeBackend: Backend,
    codexBackend: Backend,
    grokBackend?: Backend
  ) {
    this.backends = new Map([
      ['claude', claudeBackend],
      ['codex', codexBackend]
    ]);
    if (grokBackend) {
      this.backends.set('grok', grokBackend);
    }
  }

  private getBackend(cli: SessionCli): Backend {
    const backend = this.backends.get(cli);
    if (!backend) {
      throw new Error(`No backend registered for cli: ${cli}`);
    }
    return backend;
  }

  attachAutomation(automation: AutomationService): void {
    this.automation = automation;
  }

  async createSession(options: CreateSessionOptions): Promise<StoredSession> {
    if (options.host !== undefined) {
      throw new Error('create --host requires the routing session manager; this manager only creates local sessions');
    }

    const workspacePath = path.resolve(options.path ?? process.cwd());
    await this.assertWorkspacePathExists(workspacePath);
    const cli = options.cli ?? 'claude';
    const backend = this.getBackend(cli);
    const championId = options.championId !== undefined
      ? await this.claimRequestedChampionId(options.championId)
      : await this.findAvailableChampionId();
    const timestamp = new Date().toISOString();

    const result = await backend.create({
      championId,
      workspacePath,
      description: options.description,
      mode: options.mode,
      model: options.model
    });

    const session: StoredSession = {
      championId,
      internalId: result.internalId,
      cli,
      mode: result.mode,
      path: workspacePath,
      description: options.description,
      status: 'active',
      appServerPid: result.appServerPid,
      appServerPort: result.appServerPort,
      model: result.model,
      codexTurnInProgress: result.codexTurnInProgress,
      grokTurnInProgress: result.grokTurnInProgress,
      lastAssistantMessages: result.lastAssistantMessages,
      createdAt: timestamp,
      lastUsed: timestamp
    };

    try {
      await this.store.upsertSession(session);
    } catch (error: unknown) {
      // The tmux session / codex thread already exists; if it isn't recorded it
      // can never be addressed or killed. Roll it back rather than orphan it.
      try {
        await backend.kill(session);
      } catch {
        console.warn(
          `[dev-sessions] failed to roll back ${cli} session ${championId} after a store write failure; ` +
          'it may need manual cleanup'
        );
      }
      throw error;
    }

    return session;
  }

  async resumeSession(options: ResumeSessionOptions): Promise<StoredSession> {
    if (options.host !== undefined) {
      throw new Error('resume --host requires the routing session manager; this manager only resumes local sessions');
    }
    if (!options.cli) throw new Error('--cli is required when the task ID is not in the retired-session index');
    if (!options.path) throw new Error('--path is required when the task ID is not in the retired-session index');
    const workspacePath = path.resolve(options.path);
    await this.assertWorkspacePathExists(workspacePath);
    const backend = this.getBackend(options.cli);
    const championId = options.championId !== undefined
      ? await this.claimRequestedChampionId(options.championId)
      : await this.findAvailableChampionId();
    const timestamp = new Date().toISOString();
    const result = await backend.resume({
      taskId: options.taskId,
      championId,
      workspacePath,
      description: options.description,
      mode: options.mode,
      model: options.model
    });
    const session: StoredSession = {
      championId,
      internalId: result.internalId,
      cli: options.cli,
      mode: result.mode,
      path: workspacePath,
      description: options.description,
      status: 'active',
      appServerPid: result.appServerPid,
      appServerPort: result.appServerPort,
      model: result.model,
      codexTurnInProgress: result.codexTurnInProgress,
      grokTurnInProgress: result.grokTurnInProgress,
      lastAssistantMessages: result.lastAssistantMessages,
      createdAt: timestamp,
      lastUsed: timestamp
    };
    await this.store.upsertSession(session);
    return session;
  }

  async sendMessage(
    championId: string,
    message: string,
    options: EnqueueMessageOptions = {}
  ): Promise<QueuedMessage | void> {
    if (!this.automation) return this.sendMessageDirect(championId, message);
    await this.requireSession(championId);
    const queued = this.automation.enqueueMessage(championId, message, options);
    await this.automation.tick();
    return this.automation.getMessage(queued.id) ?? queued;
  }

  async sendMessageDirect(championId: string, message: string): Promise<void> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    const sendTime = new Date().toISOString();

    const preSendFields = await backend.preSendStoreFields(session, sendTime);
    if (Object.keys(preSendFields).length > 0) {
      await this.store.updateSession(championId, preSendFields);
    }

    let postSendFields: Partial<StoredSession>;
    try {
      postSendFields = await backend.send(session, message);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const errorFields = backend.onSendError(session, err);
      if (Object.keys(errorFields).length > 0) {
        await this.store.updateSession(championId, errorFields);
      }
      throw error;
    }

    if (Object.keys(postSendFields).length > 0) {
      await this.store.updateSession(championId, postSendFields);
    }
  }

  async setSessionGoal(championId: string, update: GoalUpdate): Promise<ThreadGoal> {
    const { session, backend } = await this.requireGoalBackend(championId);
    if (!backend.setGoal) {
      throw new Error('Unreachable');
    }
    return backend.setGoal(session, update);
  }

  async getSessionGoal(championId: string): Promise<ThreadGoal | undefined> {
    const { session, backend } = await this.requireGoalBackend(championId);
    if (!backend.getGoal) {
      throw new Error('Unreachable');
    }
    return backend.getGoal(session);
  }

  async clearSessionGoal(championId: string): Promise<boolean> {
    const { session, backend } = await this.requireGoalBackend(championId);
    if (!backend.clearGoal) {
      throw new Error('Unreachable');
    }
    return backend.clearGoal(session);
  }

  async waitForSessionGoal(championId: string, options: WaitOptions = {}): Promise<GoalWaitResult> {
    const { session, backend } = await this.requireGoalBackend(championId);
    if (!backend.getGoal) {
      throw new Error('Unreachable');
    }

    const timeoutMs = Math.max(1, (options.timeoutSeconds ?? 300) * 1000);
    const intervalMs = Math.max(500, (options.intervalSeconds ?? 5) * 1000);
    const startTime = Date.now();

    let goal = await backend.getGoal(session);
    if (!goal) {
      throw new Error(`No goal set for ${championId}`);
    }

    while (!TERMINAL_GOAL_STATUSES.has(goal.status)) {
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= timeoutMs) {
        return { goal, timedOut: true, elapsedMs };
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(intervalMs, timeoutMs - elapsedMs));
      });

      goal = await backend.getGoal(session);
      if (!goal) {
        // Goal was cleared out-of-band; nothing left to wait for.
        return { goal: undefined, timedOut: false, elapsedMs: Date.now() - startTime };
      }
    }

    return { goal, timedOut: false, elapsedMs: Date.now() - startTime };
  }

  async waitForSessionNextTurn(championId: string, options: WaitOptions = {}): Promise<WaitResult> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    if (!backend.waitNextTurn) {
      throw new Error(
        `--next-turn waits are only supported for codex sessions; ${championId} is a ${session.cli} session`
      );
    }

    const timeoutMs = Math.max(1, (options.timeoutSeconds ?? 300) * 1000);
    return backend.waitNextTurn(session, timeoutMs);
  }

  private async requireGoalBackend(championId: string): Promise<{ session: StoredSession; backend: Backend }> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    if (!backend.setGoal || !backend.getGoal || !backend.clearGoal) {
      throw new Error(
        `Goals are only supported for codex sessions; ${championId} is a ${session.cli} session`
      );
    }
    return { session, backend };
  }

  async killSession(championId: string): Promise<void> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);

    if (backend.retire) {
      await backend.retire(session);
    } else {
      await backend.kill(session);
    }
    this.automation?.rememberRetiredSession(session);
    await this.store.deleteSession(championId);

    const remainingActive = (await this.store.listSessions()).filter((s) => s.status === 'active');
    await backend.afterKill(remainingActive);
  }

  async retireSession(championId: string): Promise<StoredSession> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    if (backend.retire) {
      await backend.retire(session);
    } else {
      await backend.kill(session);
    }
    await this.store.deleteSession(championId);
    const remainingActive = (await this.store.listSessions()).filter((s) => s.status === 'active');
    await backend.afterKill(remainingActive);
    return session;
  }

  async resumeTask(options: ResumeSessionOptions): Promise<StoredSession> {
    if (!this.automation) return this.resumeSession(options);
    return this.automation.resumeTask(options);
  }

  listQueuedMessages(championId?: string, statuses?: MessageStatus[], limit?: number): QueuedMessage[] {
    return this.requireAutomation().listMessages(championId, statuses, limit);
  }

  getQueuedMessage(id: string): QueuedMessage | undefined {
    return this.requireAutomation().getMessage(id);
  }

  waitForQueuedMessage(id: string, options: WaitOptions = {}): Promise<MessageWaitResult> {
    return this.requireAutomation().waitForMessage(id, options);
  }

  cancelQueuedMessage(id: string): QueuedMessage {
    return this.requireAutomation().cancelMessage(id);
  }

  retryQueuedMessage(id: string): QueuedMessage {
    return this.requireAutomation().retryMessage(id);
  }

  replyToQueuedMessage(
    id: string,
    body: string,
    options: Pick<EnqueueMessageOptions, 'idempotencyKey'> = {}
  ): QueuedMessage {
    return this.requireAutomation().replyToMessage(id, body, options);
  }

  createSchedule(options: CreateScheduleOptions): Promise<Schedule> | Schedule {
    if (options.targetSessionId) {
      return this.requireAutomation().createSessionSchedule(
        options as CreateScheduleOptions & { targetSessionId: string }
      );
    }
    return this.requireAutomation().createSchedule(options);
  }

  listSchedules(): Schedule[] {
    return this.requireAutomation().listSchedules();
  }

  getSchedule(id: string): Schedule | undefined {
    return this.requireAutomation().getSchedule(id);
  }

  pauseSchedule(id: string): Schedule {
    return this.requireAutomation().pauseSchedule(id);
  }

  resumeSchedule(id: string): Schedule {
    return this.requireAutomation().resumeSchedule(id);
  }

  deleteSchedule(id: string): Schedule {
    return this.requireAutomation().deleteSchedule(id);
  }

  runScheduleNow(id: string): Promise<ScheduleRun> {
    return this.requireAutomation().runScheduleNow(id);
  }

  listScheduleRuns(scheduleId?: string, limit?: number): ScheduleRun[] {
    return this.requireAutomation().listRuns(scheduleId, limit);
  }

  getScheduleRun(id: string): ScheduleRun | undefined {
    return this.requireAutomation().getRun(id);
  }

  runAutomationTick(): Promise<void> {
    return this.requireAutomation().tick();
  }

  private requireAutomation(): AutomationService {
    if (!this.automation) throw new Error('The durable message service is not configured');
    return this.automation;
  }

  async listSessions(): Promise<StoredSession[]> {
    // Remote sessions (host set) are stubs owned by the routing manager —
    // liveness-checking them against local tmux/app-server would prune them.
    const sessions = (await this.store.listSessions()).filter(
      (session) => session.status === 'active' && session.host === undefined
    );
    const livenessChecks = await mapWithConcurrency(
      sessions,
      8,
      async (session) => {
        const backend = this.getBackend(session.cli);
        const liveness = await backend.exists(session);
        return { championId: session.championId, cli: session.cli, liveness };
      }
    );

    for (const check of livenessChecks) {
      if (check.liveness === 'unknown') {
        console.warn(`[dev-sessions] ${check.cli} liveness check failed for session ${check.championId}; keeping session record`);
      }
    }

    const deadSessions = sessions.filter((session) =>
      livenessChecks.some((check) => check.championId === session.championId && check.liveness === 'dead')
    );

    const deadDeactivateIds = deadSessions
      .filter((s) => this.getBackend(s.cli).deadSessionPolicy === 'deactivate')
      .map((s) => s.championId);

    const deadPruneIds = deadSessions
      .filter((s) => this.getBackend(s.cli).deadSessionPolicy === 'prune')
      .map((s) => s.championId);

    if (this.automation) {
      for (const session of deadSessions.filter((s) =>
        this.getBackend(s.cli).deadSessionPolicy === 'prune'
      )) {
        this.automation.rememberRetiredSession(session);
      }
    }

    if (deadDeactivateIds.length > 0) {
      await Promise.all(
        deadDeactivateIds.map((id) =>
          this.store.updateSession(id, { status: 'inactive', codexTurnInProgress: false })
        )
      );
    }

    if (deadPruneIds.length > 0) {
      await this.store.pruneSessions(deadPruneIds);
    }

    return (await this.store.listSessions()).filter(
      (session) => session.status === 'active' && session.host === undefined
    );
  }

  async getLastAssistantTextBlocks(championId: string, count: number): Promise<string[]> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    return backend.getLastMessages(session, count);
  }

  async getSessionStatus(championId: string): Promise<AgentTurnStatus> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    const result = await backend.status(session);

    if (result.storeUpdate && Object.keys(result.storeUpdate).length > 0) {
      await this.store.updateSession(championId, result.storeUpdate);
    }

    if (result.errorToThrow) {
      throw result.errorToThrow;
    }

    return result.status;
  }

  async getSessionLogs(championId: string): Promise<SessionTurn[]> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    return backend.getLogs(session);
  }

  async inspectSession(championId: string): Promise<StoredSession> {
    return this.requireSession(championId);
  }

  async waitForSession(championId: string, options: WaitOptions = {}): Promise<WaitResult> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    const timeoutMs = Math.max(0.05, options.timeoutSeconds ?? 300) * 1000;
    const intervalMs = Math.max(0.05, options.intervalSeconds ?? 2) * 1000;

    const result = await backend.wait(session, timeoutMs, intervalMs);

    if (Object.keys(result.storeUpdate).length > 0) {
      await this.store.updateSession(championId, result.storeUpdate);
    }

    if (result.errorToThrow) {
      throw result.errorToThrow;
    }

    return {
      completed: result.completed,
      timedOut: result.timedOut,
      elapsedMs: result.elapsedMs
    };
  }

  async waitForDelivery(
    championId: string,
    deliveryId: string,
    options: WaitOptions = {}
  ): Promise<WaitResult & { result?: string }> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    if (!backend.waitForDelivery) {
      const wait = await this.waitForSession(championId, options);
      const result = wait.completed
        ? (await this.getLastAssistantTextBlocks(championId, 1))[0]
        : undefined;
      return { ...wait, result };
    }

    const timeoutMs = Math.max(0.05, options.timeoutSeconds ?? 300) * 1000;
    const intervalMs = Math.max(0.05, options.intervalSeconds ?? 2) * 1000;
    const wait = await backend.waitForDelivery(session, deliveryId, timeoutMs, intervalMs);
    if (Object.keys(wait.storeUpdate).length > 0) {
      await this.store.updateSession(championId, wait.storeUpdate);
    }
    if (wait.errorToThrow) throw wait.errorToThrow;
    return {
      completed: wait.completed,
      timedOut: wait.timedOut,
      elapsedMs: wait.elapsedMs,
      result: wait.result
    };
  }

  private async requireSession(championId: string): Promise<StoredSession> {
    const session = await this.store.getSession(championId);
    if (!session) {
      throw new Error(`Session not found: ${championId}`);
    }
    return session;
  }

  private async claimRequestedChampionId(championId: string): Promise<string> {
    if (await this.store.getSession(championId) || this.automation?.reservedSessionIds().includes(championId)) {
      throw new Error(`Champion ID already in use: ${championId}`);
    }

    for (const backend of this.backends.values()) {
      if (await backend.isChampionIdTaken(championId)) {
        throw new Error(`Champion ID already in use: ${championId}`);
      }
    }

    return championId;
  }

  private async findAvailableChampionId(maxAttempts: number = 250): Promise<string> {
    const allBackends = [...this.backends.values()];
    const reserved = new Set(this.automation?.reservedSessionIds() ?? []);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = generateChampionId();

      if (reserved.has(candidate) || await this.store.getSession(candidate)) {
        continue;
      }

      let taken = false;
      for (const b of allBackends) {
        if (await b.isChampionIdTaken(candidate)) {
          taken = true;
          break;
        }
      }

      if (taken) {
        continue;
      }

      return candidate;
    }

    throw new Error('Unable to allocate a unique champion ID');
  }

  private async assertWorkspacePathExists(workspacePath: string): Promise<void> {
    try {
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Workspace path does not exist: ${workspacePath}`);
      }
      throw error;
    }
  }
}

export function shouldUseGatewaySessionManager(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEV_SESSIONS_SANDBOX === '1';
}

export function createDefaultSessionManager(
  env: NodeJS.ProcessEnv = process.env
): RoutingSessionManager | GatewaySessionManager {
  if (shouldUseGatewaySessionManager(env)) {
    return new GatewaySessionManager({
      baseUrl: resolveGatewayBaseUrl(env)
    });
  }

  const store = createDefaultSessionStore(env);
  const local = new SessionManager(
    store,
    new ClaudeBackend(new ClaudeTmuxBackend()),
    new CodexBackend(new CodexAppServerBackend()),
    new GrokBackend(new GrokAppServerBackend())
  );

  const cleanupHoursRaw = Number(env.DEV_SESSIONS_AUTO_CLEANUP_HOURS ?? 48);
  const cleanupHours = Number.isFinite(cleanupHoursRaw) && cleanupHoursRaw >= 0 ? cleanupHoursRaw : 48;
  const automation = new AutomationService(
    new AutomationStore(resolveAutomationDatabasePath(env)),
    local,
    { cleanupHours }
  );
  local.attachAutomation(automation);

  return new RoutingSessionManager(local, store, { localVersion: pkg.version, env });
}
