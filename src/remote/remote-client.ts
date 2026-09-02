import { AgentTurnStatus, GoalUpdate, SessionCli, SessionMode, SessionTurn, StoredSession, ThreadGoal, WaitResult } from '../types';
import { SshRunner, SshRunResult } from './ssh-runner';
import type {
  CreateScheduleOptions,
  EnqueueMessageOptions,
  MessageStatus,
  QueuedMessage,
  Schedule,
  ScheduleRun
} from '../automation/types';
import type { MessageWaitResult } from '../automation/service';
import type { ResumeSessionOptions } from '../session-manager';

const WAIT_TIMEOUT_EXIT_CODE = 124;

// The remote dev-sessions failed (as opposed to the ssh transport). Carries the
// remote exit code so the local CLI exits identically.
export class RemoteCommandError extends Error {
  constructor(message: string, public readonly exitCode: number) {
    super(message);
    this.name = 'RemoteCommandError';
  }
}

export interface RemoteCreateOptions {
  championId: string;
  path?: string;
  description?: string;
  cli: SessionCli;
  mode: SessionMode;
  model?: string;
}

export interface RemoteWaitOptions {
  timeoutSeconds: number;
  intervalSeconds?: number;
}

function isAgentTurnStatus(value: string): value is AgentTurnStatus {
  return value === 'idle' || value === 'working' || value === 'waiting_for_input';
}

/**
 * Talks to the dev-sessions CLI installed on a remote host. Every method maps
 * onto one remote CLI invocation with machine-readable output (--json where the
 * payload is structured, exit codes where it is not).
 */
export class RemoteHostClient {
  constructor(
    readonly host: string,
    readonly remoteBin: string,
    private readonly runner: SshRunner
  ) {}

  private async exec(args: string[], stdin?: string): Promise<SshRunResult> {
    const result = await this.runner.run(this.host, this.remoteBin, args, { stdin });

    if (result.exitCode === 127) {
      throw new RemoteCommandError(
        `dev-sessions not found on ${this.host} (tried '${this.remoteBin}' via a login shell). ` +
        `Install it there, or set DEV_SESSIONS_REMOTE_BIN to its absolute path before 'create --host'.`,
        1
      );
    }

    return result;
  }

  private assertOk(result: SshRunResult, context: string): void {
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new RemoteCommandError(`Remote ${context} on ${this.host} failed: ${detail}`, result.exitCode);
    }
  }

  private parseJson<T>(result: SshRunResult, context: string): T {
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      const preview = result.stdout.trim().slice(0, 200);
      throw new RemoteCommandError(
        `Remote ${context} on ${this.host} returned unparseable output: ${preview}`,
        1
      );
    }
  }

  async version(): Promise<string> {
    const result = await this.exec(['--version']);
    this.assertOk(result, '--version');
    return result.stdout.trim();
  }

  async create(options: RemoteCreateOptions): Promise<StoredSession> {
    const args = ['create', '--json', '--id', options.championId, '--cli', options.cli, '--mode', options.mode];
    if (options.path !== undefined) {
      args.push('--path', options.path);
    }
    if (options.description !== undefined) {
      args.push('--description', options.description);
    }
    if (options.model !== undefined) {
      args.push('--model', options.model);
    }

    const result = await this.exec(args);
    this.assertOk(result, 'create');
    return this.parseJson<StoredSession>(result, 'create');
  }

  async send(
    championId: string,
    message: string,
    options: EnqueueMessageOptions = {}
  ): Promise<QueuedMessage | undefined> {
    // Message content travels over ssh stdin (--file -), never argv: arbitrary
    // quoting/newlines and multi-hundred-KB briefings are safe.
    const args = ['send', championId, '--file', '-', '--json'];
    if (options.sourceSessionId) args.push('--from', options.sourceSessionId);
    if (options.idempotencyKey) args.push('--idempotency-key', options.idempotencyKey);
    if (options.replyToMessageId) args.push('--reply-to', options.replyToMessageId);
    const result = await this.exec(args, message);
    this.assertOk(result, 'send');
    try {
      return this.parseJson<QueuedMessage>(result, 'send');
    } catch {
      return undefined;
    }
  }

  async resume(options: ResumeSessionOptions): Promise<StoredSession> {
    const args = ['resume', options.taskId, '--json'];
    if (options.path) args.push('--path', options.path);
    if (options.cli) args.push('--cli', options.cli);
    if (options.mode) args.push('--mode', options.mode);
    if (options.model) args.push('--model', options.model);
    if (options.description) args.push('--description', options.description);
    if (options.championId) args.push('--id', options.championId);
    const result = await this.exec(args);
    this.assertOk(result, 'resume');
    return this.parseJson<StoredSession>(result, 'resume');
  }

  async messages(championId?: string, statuses?: MessageStatus[], limit: number = 100): Promise<QueuedMessage[]> {
    const args = ['messages'];
    if (championId) args.push(championId);
    if (statuses && statuses.length > 0) args.push('--status', statuses.join(','));
    args.push('--limit', String(limit), '--json');
    const result = await this.exec(args);
    this.assertOk(result, 'messages');
    return this.parseJson<QueuedMessage[]>(result, 'messages');
  }

  async message(messageId: string): Promise<QueuedMessage | undefined> {
    const result = await this.exec(['message', 'show', messageId]);
    if (result.exitCode !== 0 && /message not found/i.test(result.stderr)) return undefined;
    this.assertOk(result, 'message show');
    return this.parseJson<QueuedMessage>(result, 'message show');
  }

  async waitMessage(messageId: string, options: RemoteWaitOptions): Promise<MessageWaitResult> {
    const args = ['message', 'wait', messageId, '--timeout', String(options.timeoutSeconds)];
    if (options.intervalSeconds !== undefined) args.push('--interval', String(options.intervalSeconds));
    const started = Date.now();
    const result = await this.exec(args);
    if (result.exitCode === WAIT_TIMEOUT_EXIT_CODE) {
      const message = await this.message(messageId);
      if (!message) throw new RemoteCommandError(`Remote message not found: ${messageId}`, 1);
      return { message, timedOut: true, elapsedMs: Date.now() - started };
    }
    this.assertOk(result, 'message wait');
    return {
      message: this.parseJson<QueuedMessage>(result, 'message wait'),
      timedOut: false,
      elapsedMs: Date.now() - started
    };
  }

  async messageAction(action: 'cancel' | 'retry', messageId: string): Promise<QueuedMessage> {
    const result = await this.exec(['message', action, messageId]);
    this.assertOk(result, `message ${action}`);
    return this.parseJson<QueuedMessage>(result, `message ${action}`);
  }

  async replyMessage(messageId: string, body: string, idempotencyKey?: string): Promise<QueuedMessage> {
    const args = ['message', 'reply', messageId, '--file', '-'];
    if (idempotencyKey) args.push('--idempotency-key', idempotencyKey);
    const result = await this.exec(args, body);
    this.assertOk(result, 'message reply');
    return this.parseJson<QueuedMessage>(result, 'message reply');
  }

  async createSchedule(options: CreateScheduleOptions): Promise<Schedule> {
    const args = [
      'schedule', 'create', '--json', '--name', options.name, '--cron', options.cron,
      '--file', '-', '--misfire', options.misfirePolicy ?? 'latest',
      '--overlap', options.overlapPolicy ?? 'skip',
      '--max-lateness', `${Math.max(1, Math.ceil((options.maxLatenessMs ?? 3_600_000) / 60_000))}m`
    ];
    if (options.timezone) args.push('--timezone', options.timezone);
    if (options.targetSessionId) {
      args.push('--session', options.targetSessionId);
    } else if (options.newSession) {
      args.push('--new-session', '--path', options.newSession.path, '--cli', options.newSession.cli, '--mode', options.newSession.mode);
      if (options.newSession.model) args.push('--model', options.newSession.model);
      if (options.newSession.description) args.push('--description', options.newSession.description);
    }
    const result = await this.exec(args, options.message);
    this.assertOk(result, 'schedule create');
    return this.parseJson<Schedule>(result, 'schedule create');
  }

  async schedules(): Promise<Schedule[]> {
    const result = await this.exec(['schedules', '--json']);
    this.assertOk(result, 'schedules');
    return this.parseJson<Schedule[]>(result, 'schedules');
  }

  async scheduleAction(action: 'show' | 'pause' | 'resume' | 'delete', id: string): Promise<Schedule | undefined> {
    const result = await this.exec(['schedule', action, id]);
    if (action === 'show' && result.exitCode !== 0 && /schedule not found/i.test(result.stderr)) return undefined;
    this.assertOk(result, `schedule ${action}`);
    return this.parseJson<Schedule>(result, `schedule ${action}`);
  }

  async runScheduleNow(id: string): Promise<ScheduleRun> {
    const result = await this.exec(['schedule', 'run', id]);
    this.assertOk(result, 'schedule run');
    return this.parseJson<ScheduleRun>(result, 'schedule run');
  }

  async runs(scheduleId?: string, limit: number = 100): Promise<ScheduleRun[]> {
    const args = ['runs'];
    if (scheduleId) args.push(scheduleId);
    args.push('--limit', String(limit), '--json');
    const result = await this.exec(args);
    this.assertOk(result, 'runs');
    return this.parseJson<ScheduleRun[]>(result, 'runs');
  }

  async run(id: string): Promise<ScheduleRun | undefined> {
    const result = await this.exec(['run', id]);
    if (result.exitCode !== 0 && /run not found/i.test(result.stderr)) return undefined;
    this.assertOk(result, 'run');
    return this.parseJson<ScheduleRun>(result, 'run');
  }

  async status(championId: string): Promise<AgentTurnStatus> {
    const result = await this.exec(['status', championId]);
    this.assertOk(result, 'status');
    const status = result.stdout.trim();
    if (!isAgentTurnStatus(status)) {
      throw new RemoteCommandError(`Remote status on ${this.host} returned invalid status: ${status}`, 1);
    }
    return status;
  }

  async wait(championId: string, options: RemoteWaitOptions): Promise<WaitResult> {
    const args = ['wait', championId, '--timeout', String(options.timeoutSeconds)];
    if (options.intervalSeconds !== undefined) {
      args.push('--interval', String(options.intervalSeconds));
    }
    return this.execWait(args, 'wait');
  }

  async waitNextTurn(championId: string, options: RemoteWaitOptions): Promise<WaitResult> {
    return this.execWait(
      ['wait', championId, '--next-turn', '--timeout', String(options.timeoutSeconds)],
      'wait --next-turn'
    );
  }

  async waitGoal(championId: string, options: RemoteWaitOptions): Promise<WaitResult> {
    const args = ['wait', championId, '--goal', '--timeout', String(options.timeoutSeconds)];
    if (options.intervalSeconds !== undefined) {
      args.push('--interval', String(options.intervalSeconds));
    }
    return this.execWait(args, 'wait --goal');
  }

  private async execWait(args: string[], context: string): Promise<WaitResult> {
    const startTime = Date.now();
    const result = await this.exec(args);
    const elapsedMs = Date.now() - startTime;

    if (result.exitCode === WAIT_TIMEOUT_EXIT_CODE) {
      return { completed: false, timedOut: true, elapsedMs };
    }

    this.assertOk(result, context);
    return { completed: true, timedOut: false, elapsedMs };
  }

  async lastMessages(championId: string, count: number): Promise<string[]> {
    const result = await this.exec(['last-message', championId, '-n', String(count), '--json']);
    this.assertOk(result, 'last-message');
    return this.parseJson<string[]>(result, 'last-message');
  }

  async logs(championId: string): Promise<SessionTurn[]> {
    const result = await this.exec(['logs', championId, '--json']);
    this.assertOk(result, 'logs');
    return this.parseJson<SessionTurn[]>(result, 'logs');
  }

  async inspect(championId: string): Promise<StoredSession> {
    const result = await this.exec(['inspect', championId]);
    this.assertOk(result, 'inspect');
    return this.parseJson<StoredSession>(result, 'inspect');
  }

  async list(): Promise<StoredSession[]> {
    const result = await this.exec(['list', '--json']);
    this.assertOk(result, 'list');
    return this.parseJson<StoredSession[]>(result, 'list');
  }

  async kill(championId: string): Promise<void> {
    const result = await this.exec(['kill', championId]);
    this.assertOk(result, 'kill');
  }

  async setGoal(championId: string, update: GoalUpdate): Promise<ThreadGoal> {
    const args = ['goal', championId];
    if (update.status === 'paused') {
      args.push('--pause');
    } else if (update.status === 'active' && update.objective === undefined) {
      args.push('--resume');
    }
    if (typeof update.tokenBudget === 'number') {
      args.push('--budget', String(update.tokenBudget));
    }
    args.push('--json');
    if (update.objective !== undefined) {
      // Options first, then '--', then the objective: stops option parsing so
      // objectives that start with '-' (e.g. markdown bullets) aren't misread
      // as CLI flags by the remote CLI.
      args.push('--', update.objective);
    }

    const result = await this.exec(args);
    this.assertOk(result, 'goal set');
    return this.parseJson<ThreadGoal>(result, 'goal set');
  }

  async getGoal(championId: string): Promise<ThreadGoal | undefined> {
    const result = await this.exec(['goal', championId, '--json']);
    this.assertOk(result, 'goal get');
    const goal = this.parseJson<ThreadGoal | null>(result, 'goal get');
    return goal ?? undefined;
  }

  async clearGoal(championId: string): Promise<boolean> {
    const result = await this.exec(['goal', championId, '--clear', '--json']);
    this.assertOk(result, 'goal clear');
    return this.parseJson<{ cleared: boolean }>(result, 'goal clear').cleared === true;
  }
}
