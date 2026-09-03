import { generateChampionId } from '../champion-ids';
import type {
  CreateSessionOptions,
  GoalWaitResult,
  ResumeSessionOptions,
  SessionManager,
  WaitOptions
} from '../session-manager';
import { SessionStore } from '../session-store';
import { AgentTurnStatus, GoalUpdate, SessionTurn, StoredSession, ThreadGoal, WaitResult } from '../types';
import type {
  CreateScheduleOptions,
  EnqueueMessageOptions,
  MessageStatus,
  QueuedMessage,
  Schedule,
  ScheduleRun
} from '../automation/types';
import type { MessageWaitResult } from '../automation/service';
import { RemoteCommandError, RemoteHostClient } from './remote-client';
import { SshRunner, SshTransportError } from './ssh-runner';

const CHAMPION_ID_ALLOCATION_ATTEMPTS = 5;

function routedId(host: string, id: string): string {
  return `${encodeURIComponent(host)}::${id}`;
}

function splitRoutedId(id: string): { host?: string; id: string } {
  const separator = id.indexOf('::');
  if (separator < 0) return { id };
  return {
    host: decodeURIComponent(id.slice(0, separator)),
    id: id.slice(separator + 2)
  };
}

function routeMessage(host: string, message: QueuedMessage): QueuedMessage {
  return {
    ...message,
    id: routedId(host, message.id),
    correlationId: routedId(host, message.correlationId),
    replyToMessageId: message.replyToMessageId ? routedId(host, message.replyToMessageId) : undefined
  };
}

function routeSchedule(host: string, schedule: Schedule): Schedule {
  return { ...schedule, id: routedId(host, schedule.id) };
}

function routeRun(host: string, run: ScheduleRun): ScheduleRun {
  return {
    ...run,
    id: routedId(host, run.id),
    scheduleId: routedId(host, run.scheduleId),
    messageId: run.messageId ? routedId(host, run.messageId) : undefined
  };
}

export type RemoteClientFactory = (host: string, remoteBin: string) => RemoteHostClient;

export interface RoutingSessionManagerOptions {
  localVersion: string;
  clientFactory?: RemoteClientFactory;
  warn?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

export function resolveRemoteBin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DEV_SESSIONS_REMOTE_BIN;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return 'dev-sessions';
}

/**
 * Versions are compatible when the remote CLI speaks the same relay protocol:
 * same major, and (while we are pre-1.0) same minor.
 */
export function isCompatibleRemoteVersion(local: string, remote: string): boolean {
  const parse = (value: string): [number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\./.exec(value.trim());
    if (!match) {
      return undefined;
    }
    return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
  };

  const localParts = parse(local);
  const remoteParts = parse(remote);
  if (!localParts || !remoteParts) {
    return false;
  }

  if (localParts[0] !== remoteParts[0]) {
    return false;
  }

  return localParts[0] !== 0 || localParts[1] === remoteParts[1];
}

/**
 * Routes commands to the local SessionManager or, for sessions created with
 * `create --host`, to the dev-sessions CLI on the remote host over ssh. The
 * local store is the registry of record: it maps champion ID -> host, and
 * remote sessions are stored as stubs mirroring the remote record.
 */
export class RoutingSessionManager {
  private readonly clientFactory: RemoteClientFactory;

  private readonly warn: (message: string) => void;

  private readonly localVersion: string;

  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly local: SessionManager,
    private readonly store: SessionStore,
    options: RoutingSessionManagerOptions
  ) {
    const defaultRunner = new SshRunner();
    this.clientFactory = options.clientFactory ?? ((host, remoteBin) => new RemoteHostClient(host, remoteBin, defaultRunner));
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
    this.localVersion = options.localVersion;
    this.env = options.env ?? process.env;
  }

  private clientFor(session: StoredSession): RemoteHostClient {
    return this.clientFactory(session.host as string, session.remoteBin ?? resolveRemoteBin(this.env));
  }

  private async clientForHost(host: string): Promise<RemoteHostClient> {
    const savedRemoteBin = await this.store.getRemoteBin(host);
    const sessions = (await this.store.listSessions()).filter(
      (session) => session.host === host && session.remoteBin
    );
    const remoteBin = savedRemoteBin ?? sessions[sessions.length - 1]?.remoteBin ?? resolveRemoteBin(this.env);
    return this.clientFactory(host, remoteBin);
  }

  private async lookup(championId: string): Promise<StoredSession | undefined> {
    return this.store.getSession(championId);
  }

  async createSession(options: CreateSessionOptions): Promise<StoredSession> {
    if (options.host === undefined) {
      return this.local.createSession(options);
    }

    const host = options.host;
    const remoteBin = resolveRemoteBin(this.env);
    const client = this.clientFactory(host, remoteBin);

    const remoteVersion = await client.version();
    if (!isCompatibleRemoteVersion(this.localVersion, remoteVersion)) {
      this.warn(
        `[dev-sessions] warning: remote ${host} runs dev-sessions ${remoteVersion}, local is ${this.localVersion} — ` +
        `remote commands may fail; upgrade the remote install`
      );
    }

    // The local registry spans all hosts, so the ID is allocated here and
    // handed to the remote — this is what keeps IDs unique across hosts.
    let remoteSession: StoredSession | undefined;
    for (let attempt = 0; attempt < CHAMPION_ID_ALLOCATION_ATTEMPTS && !remoteSession; attempt += 1) {
      const championId = options.championId ?? generateChampionId();
      if (options.championId === undefined && (await this.store.getSession(championId))) {
        continue;
      }

      try {
        remoteSession = await client.create({
          championId,
          path: options.path,
          description: options.description,
          cli: options.cli ?? 'claude',
          mode: options.mode ?? 'native',
          model: options.model
        });
      } catch (error: unknown) {
        const takenRemotely =
          options.championId === undefined &&
          error instanceof RemoteCommandError &&
          /already in use/i.test(error.message);
        if (!takenRemotely) {
          throw error;
        }
      }
    }

    if (!remoteSession) {
      throw new Error(`Unable to allocate a champion ID free on both this machine and ${host}`);
    }

    const stub: StoredSession = { ...remoteSession, host, remoteBin };
    await this.store.setRemoteBin(host, remoteBin);
    await this.store.upsertSession(stub);
    return stub;
  }

  async resumeTask(options: ResumeSessionOptions): Promise<StoredSession> {
    if (!options.host) return this.local.resumeTask(options);
    const remoteBin = resolveRemoteBin(this.env);
    const client = this.clientFactory(options.host, remoteBin);
    const remote = await client.resume({ ...options, host: undefined });
    const stub = { ...remote, host: options.host, remoteBin };
    await this.store.setRemoteBin(options.host, remoteBin);
    await this.store.upsertSession(stub);
    return stub;
  }

  async sendMessage(
    championId: string,
    message: string,
    options: EnqueueMessageOptions = {}
  ): Promise<QueuedMessage | void> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.sendMessage(championId, message, options);
    }
    const hasQueueOptions = options.sourceSessionId !== undefined ||
      options.idempotencyKey !== undefined ||
      options.replyToMessageId !== undefined;
    const client = this.clientFor(session);
    const replyRoute = options.replyToMessageId ? splitRoutedId(options.replyToMessageId) : undefined;
    if (replyRoute?.host && replyRoute.host !== session.host) {
      throw new Error('A reply message and its original message must be stored on the same host');
    }
    const remoteOptions = replyRoute
      ? { ...options, replyToMessageId: replyRoute.id }
      : options;
    const remote = hasQueueOptions
      ? await client.send(championId, message, remoteOptions)
      : await client.send(championId, message);
    await this.store.updateSession(championId, { lastUsed: new Date().toISOString() });
    return remote ? routeMessage(session.host, remote) : undefined;
  }

  async sendMessageDirect(championId: string, message: string): Promise<void> {
    const session = await this.lookup(championId);
    if (!session?.host) return this.local.sendMessageDirect(championId, message);
    await this.clientFor(session).send(championId, message);
  }

  async retireSession(championId: string): Promise<StoredSession> {
    const session = await this.lookup(championId);
    if (!session?.host) return this.local.retireSession(championId);
    await this.clientFor(session).kill(championId);
    await this.store.deleteSession(championId);
    return session;
  }

  async listQueuedMessages(
    championId?: string,
    statuses?: MessageStatus[],
    limit: number = 100,
    host?: string
  ): Promise<QueuedMessage[]> {
    if (host) {
      return (await (await this.clientForHost(host)).messages(championId, statuses, limit))
        .map((message) => routeMessage(host, message));
    }
    if (!championId) return this.local.listQueuedMessages(undefined, statuses, limit);
    const session = await this.lookup(championId);
    if (!session?.host) return this.local.listQueuedMessages(championId, statuses, limit);
    return (await this.clientFor(session).messages(championId, statuses, limit))
      .map((message) => routeMessage(session.host as string, message));
  }

  async getQueuedMessage(id: string, routeSessionId?: string): Promise<QueuedMessage | undefined> {
    const routed = splitRoutedId(id);
    const session = routeSessionId ? await this.lookup(routeSessionId) : undefined;
    const host = routed.host ?? session?.host;
    if (!host) return this.local.getQueuedMessage(routed.id);
    const client = session?.host === host
      ? this.clientFor(session)
      : await this.clientForHost(host);
    const message = await client.message(routed.id);
    return message ? routeMessage(host, message) : undefined;
  }

  async waitForQueuedMessage(id: string, options: WaitOptions = {}, routeSessionId?: string): Promise<MessageWaitResult> {
    const routed = splitRoutedId(id);
    const session = routeSessionId ? await this.lookup(routeSessionId) : undefined;
    const host = routed.host ?? session?.host;
    if (!host) return this.local.waitForQueuedMessage(routed.id, options);
    const client = session?.host === host
      ? this.clientFor(session)
      : await this.clientForHost(host);
    const result = await client.waitMessage(routed.id, {
      timeoutSeconds: options.timeoutSeconds ?? 300,
      intervalSeconds: options.intervalSeconds
    });
    return { ...result, message: routeMessage(host, result.message) };
  }

  async cancelQueuedMessage(id: string, routeSessionId?: string): Promise<QueuedMessage> {
    return this.remoteMessageAction('cancel', id, routeSessionId);
  }

  async retryQueuedMessage(id: string, routeSessionId?: string): Promise<QueuedMessage> {
    return this.remoteMessageAction('retry', id, routeSessionId);
  }

  async replyToQueuedMessage(
    id: string,
    body: string,
    options: Pick<EnqueueMessageOptions, 'idempotencyKey'> = {},
    routeSessionId?: string
  ): Promise<QueuedMessage> {
    const routed = splitRoutedId(id);
    const session = routeSessionId ? await this.lookup(routeSessionId) : undefined;
    const host = routed.host ?? session?.host;
    if (!host) return this.local.replyToQueuedMessage(routed.id, body, options);
    const client = session?.host === host
      ? this.clientFor(session)
      : await this.clientForHost(host);
    return routeMessage(host, await client.replyMessage(routed.id, body, options.idempotencyKey));
  }

  async createSchedule(options: CreateScheduleOptions): Promise<Schedule> {
    let host = options.host;
    let remoteBin = resolveRemoteBin(this.env);
    if (options.targetSessionId) {
      const session = await this.lookup(options.targetSessionId);
      host = host ?? session?.host;
      remoteBin = session?.remoteBin ?? remoteBin;
    }
    if (!host) return await this.local.createSchedule(options);
    const remote = await this.clientFactory(host, remoteBin).createSchedule({ ...options, host: undefined });
    await this.store.setRemoteBin(host, remoteBin);
    return routeSchedule(host, remote);
  }

  async listSchedules(host?: string): Promise<Schedule[]> {
    if (!host) return this.local.listSchedules();
    return (await (await this.clientForHost(host)).schedules()).map((schedule) => routeSchedule(host, schedule));
  }

  async getSchedule(id: string): Promise<Schedule | undefined> {
    const routed = splitRoutedId(id);
    if (!routed.host) return this.local.getSchedule(routed.id);
    const schedule = await (await this.clientForHost(routed.host)).scheduleAction('show', routed.id);
    return schedule ? routeSchedule(routed.host, schedule) : undefined;
  }

  async pauseSchedule(id: string): Promise<Schedule> {
    return this.remoteScheduleAction('pause', id);
  }

  async resumeSchedule(id: string): Promise<Schedule> {
    return this.remoteScheduleAction('resume', id);
  }

  async deleteSchedule(id: string): Promise<Schedule> {
    return this.remoteScheduleAction('delete', id);
  }

  async runScheduleNow(id: string): Promise<ScheduleRun> {
    const routed = splitRoutedId(id);
    if (!routed.host) return this.local.runScheduleNow(routed.id);
    return routeRun(routed.host, await (await this.clientForHost(routed.host)).runScheduleNow(routed.id));
  }

  async listScheduleRuns(scheduleId?: string, limit: number = 100, host?: string): Promise<ScheduleRun[]> {
    if (host) {
      return (await (await this.clientForHost(host)).runs(scheduleId, limit))
        .map((run) => routeRun(host, run));
    }
    if (!scheduleId) return this.local.listScheduleRuns(undefined, limit);
    const routed = splitRoutedId(scheduleId);
    if (!routed.host) return this.local.listScheduleRuns(routed.id, limit);
    return (await (await this.clientForHost(routed.host)).runs(routed.id, limit))
      .map((run) => routeRun(routed.host as string, run));
  }

  async getScheduleRun(id: string): Promise<ScheduleRun | undefined> {
    const routed = splitRoutedId(id);
    if (!routed.host) return this.local.getScheduleRun(routed.id);
    const run = await (await this.clientForHost(routed.host)).run(routed.id);
    return run ? routeRun(routed.host, run) : undefined;
  }

  runAutomationTick(): Promise<void> {
    return this.local.runAutomationTick();
  }

  private async remoteMessageAction(
    action: 'cancel' | 'retry',
    id: string,
    routeSessionId?: string
  ): Promise<QueuedMessage> {
    const routed = splitRoutedId(id);
    const session = routeSessionId ? await this.lookup(routeSessionId) : undefined;
    const host = routed.host ?? session?.host;
    if (!host) {
      return action === 'cancel'
        ? this.local.cancelQueuedMessage(routed.id)
        : this.local.retryQueuedMessage(routed.id);
    }
    const client = session?.host === host
      ? this.clientFor(session)
      : await this.clientForHost(host);
    return routeMessage(host, await client.messageAction(action, routed.id));
  }

  private async remoteScheduleAction(action: 'pause' | 'resume' | 'delete', id: string): Promise<Schedule> {
    const routed = splitRoutedId(id);
    if (!routed.host) {
      return action === 'pause'
        ? this.local.pauseSchedule(routed.id)
        : action === 'resume'
          ? this.local.resumeSchedule(routed.id)
          : this.local.deleteSchedule(routed.id);
    }
    const schedule = await (await this.clientForHost(routed.host)).scheduleAction(action, routed.id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    return routeSchedule(routed.host, schedule);
  }

  async killSession(championId: string): Promise<void> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.killSession(championId);
    }

    try {
      await this.clientFor(session).kill(championId);
    } catch (error: unknown) {
      // The remote session may already be gone; the stub should still be
      // removable. Transport failures propagate — we can't confirm anything.
      if (error instanceof SshTransportError) {
        throw error;
      }
      if (!(error instanceof RemoteCommandError) || !/session not found/i.test(error.message)) {
        throw error;
      }
    }

    await this.store.deleteSession(championId);
  }

  async listSessions(): Promise<StoredSession[]> {
    const localSessions = await this.local.listSessions();

    const stubs = (await this.store.listSessions()).filter(
      (session) => session.host !== undefined && session.status === 'active'
    );

    const byHost = new Map<string, StoredSession[]>();
    for (const stub of stubs) {
      const key = `${stub.host}\0${stub.remoteBin ?? 'dev-sessions'}`;
      byHost.set(key, [...(byHost.get(key) ?? []), stub]);
    }

    const remoteSessions: StoredSession[] = [];
    for (const [, hostStubs] of byHost) {
      const { host, remoteBin } = hostStubs[0];
      try {
        const remoteList = await this.clientFactory(host as string, remoteBin ?? 'dev-sessions').list();
        const remoteById = new Map(remoteList.map((session) => [session.championId, session]));

        for (const stub of hostStubs) {
          const remote = remoteById.get(stub.championId);
          if (!remote) {
            // Session no longer exists on the remote — drop the stale stub.
            await this.store.deleteSession(stub.championId);
            continue;
          }
          const merged: StoredSession = { ...remote, host, remoteBin };
          await this.store.upsertSession(merged);
          remoteSessions.push(merged);
        }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        this.warn(`[dev-sessions] warning: could not reach ${host} (${detail}); showing cached session records`);
        remoteSessions.push(...hostStubs);
      }
    }

    return [...localSessions, ...remoteSessions];
  }

  async getLastAssistantTextBlocks(championId: string, count: number): Promise<string[]> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.getLastAssistantTextBlocks(championId, count);
    }
    return this.clientFor(session).lastMessages(championId, count);
  }

  async getSessionStatus(championId: string): Promise<AgentTurnStatus> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.getSessionStatus(championId);
    }
    return this.clientFor(session).status(championId);
  }

  async waitForSession(championId: string, options: WaitOptions): Promise<WaitResult> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.waitForSession(championId, options);
    }
    return this.clientFor(session).wait(championId, {
      timeoutSeconds: options.timeoutSeconds ?? 300,
      intervalSeconds: options.intervalSeconds
    });
  }

  async getSessionLogs(championId: string): Promise<SessionTurn[]> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.getSessionLogs(championId);
    }
    return this.clientFor(session).logs(championId);
  }

  async inspectSession(championId: string): Promise<StoredSession> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.inspectSession(championId);
    }
    const remote = await this.clientFor(session).inspect(championId);
    return { ...remote, host: session.host, remoteBin: session.remoteBin };
  }

  async setSessionGoal(championId: string, update: GoalUpdate): Promise<ThreadGoal> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.setSessionGoal(championId, update);
    }
    return this.clientFor(session).setGoal(championId, update);
  }

  async getSessionGoal(championId: string): Promise<ThreadGoal | undefined> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.getSessionGoal(championId);
    }
    return this.clientFor(session).getGoal(championId);
  }

  async clearSessionGoal(championId: string): Promise<boolean> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.clearSessionGoal(championId);
    }
    return this.clientFor(session).clearGoal(championId);
  }

  async waitForSessionGoal(championId: string, options: WaitOptions): Promise<GoalWaitResult> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.waitForSessionGoal(championId, options);
    }

    const client = this.clientFor(session);
    const result = await client.waitGoal(championId, {
      timeoutSeconds: options.timeoutSeconds ?? 300,
      intervalSeconds: options.intervalSeconds
    });

    if (result.timedOut) {
      const goal = await client.getGoal(championId);
      return { goal, timedOut: true, elapsedMs: result.elapsedMs };
    }

    const goal = await client.getGoal(championId);
    return { goal, timedOut: false, elapsedMs: result.elapsedMs };
  }

  async waitForSessionNextTurn(championId: string, options: WaitOptions): Promise<WaitResult> {
    const session = await this.lookup(championId);
    if (!session?.host) {
      return this.local.waitForSessionNextTurn(championId, options);
    }
    return this.clientFor(session).waitNextTurn(championId, {
      timeoutSeconds: options.timeoutSeconds ?? 300
    });
  }
}
