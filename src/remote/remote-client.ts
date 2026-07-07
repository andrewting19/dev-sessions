import { AgentTurnStatus, GoalUpdate, SessionCli, SessionMode, SessionTurn, StoredSession, ThreadGoal, WaitResult } from '../types';
import { SshRunner, SshRunResult } from './ssh-runner';

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

  async send(championId: string, message: string): Promise<void> {
    // Message content travels over ssh stdin (--file -), never argv: arbitrary
    // quoting/newlines and multi-hundred-KB briefings are safe.
    const result = await this.exec(['send', championId, '--file', '-'], message);
    this.assertOk(result, 'send');
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
