import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import pkg from '../package.json';
import {
  createDefaultSessionManager,
  CreateSessionOptions,
  GoalWaitResult,
  ResumeSessionOptions,
  WaitOptions
} from './session-manager';
import {
  getGatewayDaemonStatus,
  installGatewayDaemon,
  uninstallGatewayDaemon
} from './gateway/daemon';
import { resolveGatewayCliBinary, resolveGatewayPort, startGatewayServer } from './gateway/server';
import { AgentTurnStatus, GoalUpdate, SessionTurn, StoredSession, ThreadGoal, WaitResult } from './types';
import {
  CreateScheduleOptions,
  EnqueueMessageOptions,
  MessageStatus,
  NewSessionTemplate,
  QueuedMessage,
  Schedule,
  ScheduleRun
} from './automation/types';
import { MessageWaitResult } from './automation/service';

interface CliIO {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

type InstallSkillScope = 'global' | 'local';
type InstallSkillTarget = 'claude' | 'codex';

interface InstallSkillTargetResolution {
  targets: InstallSkillTarget[];
  defaultedToClaude: boolean;
}

export interface InstallSkillDependencies {
  skillsDirectory(): string;
  listDirectory(dirPath: string): Promise<string[]>;
  cwd(): string;
  homedir(): string;
  pathExists(candidatePath: string): Promise<boolean>;
  mkdir(directoryPath: string, options: { recursive: true }): Promise<void>;
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  writeFile(filePath: string, content: string, encoding: BufferEncoding): Promise<void>;
}

export interface BuildProgramDependencies {
  installSkill?: Partial<InstallSkillDependencies>;
  // Reads message content from stdin (send/ask --file -). Injectable for tests.
  readStdin?: () => Promise<string>;
}

async function readStdinToEnd(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface SessionManagerLike {
  createSession(options: CreateSessionOptions): Promise<StoredSession>;
  sendMessage(championId: string, message: string, options?: EnqueueMessageOptions): Promise<QueuedMessage | void>;
  killSession(championId: string): Promise<void>;
  listSessions(): Promise<StoredSession[]>;
  getLastAssistantTextBlocks(championId: string, count: number): Promise<string[]>;
  getSessionStatus(championId: string): Promise<AgentTurnStatus>;
  waitForSession(championId: string, options: WaitOptions): Promise<WaitResult>;
  getSessionLogs(championId: string): Promise<SessionTurn[]>;
  inspectSession(championId: string): Promise<StoredSession>;
  setSessionGoal(championId: string, update: GoalUpdate): Promise<ThreadGoal>;
  getSessionGoal(championId: string): Promise<ThreadGoal | undefined>;
  clearSessionGoal(championId: string): Promise<boolean>;
  waitForSessionGoal(championId: string, options: WaitOptions): Promise<GoalWaitResult>;
  waitForSessionNextTurn(championId: string, options: WaitOptions): Promise<WaitResult>;
  resumeTask?(options: ResumeSessionOptions): Promise<StoredSession>;
  listQueuedMessages?(championId?: string, statuses?: MessageStatus[], limit?: number, host?: string): QueuedMessage[] | Promise<QueuedMessage[]>;
  getQueuedMessage?(id: string, routeSessionId?: string): QueuedMessage | undefined | Promise<QueuedMessage | undefined>;
  waitForQueuedMessage?(id: string, options?: WaitOptions, routeSessionId?: string): Promise<MessageWaitResult>;
  cancelQueuedMessage?(id: string, routeSessionId?: string): QueuedMessage | Promise<QueuedMessage>;
  retryQueuedMessage?(id: string, routeSessionId?: string): QueuedMessage | Promise<QueuedMessage>;
  replyToQueuedMessage?(
    id: string,
    body: string,
    options?: Pick<EnqueueMessageOptions, 'idempotencyKey'>,
    routeSessionId?: string
  ): QueuedMessage | Promise<QueuedMessage>;
  createSchedule?(options: CreateScheduleOptions): Schedule | Promise<Schedule>;
  listSchedules?(host?: string): Schedule[] | Promise<Schedule[]>;
  getSchedule?(id: string): Schedule | undefined | Promise<Schedule | undefined>;
  pauseSchedule?(id: string): Schedule | Promise<Schedule>;
  resumeSchedule?(id: string): Schedule | Promise<Schedule>;
  deleteSchedule?(id: string): Schedule | Promise<Schedule>;
  runScheduleNow?(id: string): Promise<ScheduleRun>;
  listScheduleRuns?(scheduleId?: string, limit?: number, host?: string): ScheduleRun[] | Promise<ScheduleRun[]>;
  getScheduleRun?(id: string): ScheduleRun | undefined | Promise<ScheduleRun | undefined>;
  runAutomationTick?(): Promise<void>;
}

class CliError extends Error {
  constructor(message: string, public readonly exitCode: number = 1) {
    super(message);
    this.name = 'CliError';
  }
}

function parsePositiveInteger(raw: string, flagName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliError(`${flagName} must be a positive integer`);
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`${flagName} must be a positive integer`);
  }

  return value;
}

function parsePositiveNumber(raw: string, flagName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`${flagName} must be a positive number`);
  }

  return value;
}

function parseDurationMs(raw: string, flagName: string): number {
  const match = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!match) {
    throw new CliError(`${flagName} must be a duration like 30m, 72h, or 7d`);
  }

  const value = Number.parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`${flagName} must be a positive duration`);
  }

  const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  return value * unitMs;
}

const MESSAGE_STATUSES: MessageStatus[] = [
  'waiting',
  'dispatching',
  'delivered',
  'completed',
  'failed',
  'cancelled',
  'delivery_uncertain'
];

function parseMessageStatuses(raw: string | undefined): MessageStatus[] | undefined {
  if (!raw) return undefined;
  const statuses = raw.split(',').map((value) => value.trim()).filter(Boolean);
  for (const status of statuses) {
    if (!MESSAGE_STATUSES.includes(status as MessageStatus)) {
      throw new CliError(`Unknown message status: ${status}`);
    }
  }
  return statuses as MessageStatus[];
}

function requireManagerMethod<T>(value: T | undefined, feature: string): T {
  if (!value) throw new CliError(`${feature} is not available through this dev-sessions connection`);
  return value;
}

function getDefaultWorkspacePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEV_SESSIONS_SANDBOX === '1' && typeof env.HOST_PATH === 'string' && env.HOST_PATH.trim().length > 0) {
    return env.HOST_PATH;
  }

  return process.cwd();
}

function formatSessionsTable(sessions: StoredSession[]): string {
  const headers = ['ID', 'CLI', 'MODE', 'HOST', 'STATUS', 'PATH', 'DESCRIPTION', 'LAST USED'];
  const rows = sessions.map((session) => [
    session.championId,
    session.cli,
    session.mode,
    session.host ?? 'local',
    session.status,
    session.path,
    session.description ?? '',
    session.lastUsed
  ]);

  const widths = headers.map((header, index) => {
    const rowWidths = rows.map((row) => row[index].length);
    return Math.max(header.length, ...rowWidths);
  });

  const formatRow = (row: string[]): string => row
    .map((cell, index) => cell.padEnd(widths[index]))
    .join('  ');

  const separator = widths.map((width) => '-'.repeat(width));

  return [
    formatRow(headers),
    formatRow(separator),
    ...rows.map((row) => formatRow(row))
  ].join('\n');
}

function formatGoal(goal: ThreadGoal): string {
  const lines = [
    `objective: ${goal.objective}`,
    `status: ${goal.status}`,
    `tokens used: ${goal.tokensUsed}`,
    `token budget: ${goal.tokenBudget ?? 'none'}`,
    `time used: ${goal.timeUsedSeconds}s`
  ];
  return lines.join('\n');
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function createDefaultInstallSkillDependencies(): InstallSkillDependencies {
  return {
    skillsDirectory: () => path.resolve(__dirname, '..', 'skills'),
    listDirectory: async (dirPath: string): Promise<string[]> => {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    },
    cwd: () => process.cwd(),
    homedir: () => os.homedir(),
    pathExists,
    mkdir: async (directoryPath, options) => {
      await mkdir(directoryPath, options);
    },
    readFile: async (filePath, encoding) => readFile(filePath, encoding),
    writeFile: async (filePath, content, encoding) => {
      await writeFile(filePath, content, encoding);
    }
  };
}

function resolveInstallSkillScope(options: { global?: boolean; local?: boolean }): InstallSkillScope {
  if (options.global && options.local) {
    throw new CliError('Cannot use both --global and --local');
  }

  return options.local ? 'local' : 'global';
}

async function resolveInstallSkillTargets(
  options: { claude?: boolean; codex?: boolean },
  dependencies: InstallSkillDependencies
): Promise<InstallSkillTargetResolution> {
  const targets: InstallSkillTarget[] = [];

  if (options.claude) {
    targets.push('claude');
  }

  if (options.codex) {
    targets.push('codex');
  }

  if (targets.length > 0) {
    return {
      targets,
      defaultedToClaude: false
    };
  }

  const [claudeExists, codexExists] = await Promise.all([
    dependencies.pathExists(path.join(dependencies.homedir(), '.claude')),
    dependencies.pathExists(path.join(dependencies.homedir(), '.codex'))
  ]);

  if (claudeExists) {
    targets.push('claude');
  }

  if (codexExists) {
    targets.push('codex');
  }

  if (targets.length === 0) {
    return {
      targets: ['claude'],
      defaultedToClaude: true
    };
  }

  return {
    targets,
    defaultedToClaude: false
  };
}

export function buildProgram(
  manager: SessionManagerLike,
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
  dependencies: BuildProgramDependencies = {}
): Command {
  const program = new Command();
  const installSkillDependencies: InstallSkillDependencies = {
    ...createDefaultInstallSkillDependencies(),
    ...dependencies.installSkill
  };

  program
    .name('dev-sessions')
    .description('Spawn and manage coding agent sessions')
    .version(pkg.version);

  program
    .command('create')
    .description('Create a new agent session')
    .option('-p, --path <path>', 'Workspace path to run the agent in (default: current directory)')
    .option('-d, --description <description>', 'Optional description for the session')
    .addOption(
      new Option('--cli <cli>', 'Agent CLI backend')
        .choices(['claude', 'codex', 'grok'])
        .default('claude')
    )
    .addOption(
      new Option('-m, --mode <mode>', 'Session mode')
        .choices(['native', 'docker'])
        .default('native')
    )
    .option('--model <model>', 'Model override (Codex or Grok; defaults to the selected CLI configuration)')
    .option(
      '--host <ssh-target>',
      'Create the session on a remote host over SSH (anything ssh accepts, e.g. an alias from ~/.ssh/config); ' +
      '--path is interpreted on the remote, and all other commands route to it automatically'
    )
    .addOption(new Option('--id <champion-id>', 'Use a pre-allocated session ID (used by the remote relay)').hideHelp())
    .option('--json', 'Print the full session record as JSON')
    .option('-q, --quiet', 'Only print session ID (for scripts)')
    .action(async (options: {
      path?: string;
      description?: string;
      cli: 'claude' | 'codex' | 'grok';
      mode: 'native' | 'docker';
      model?: string;
      host?: string;
      id?: string;
      json?: boolean;
      quiet?: boolean;
    }) => {
      // For remote sessions an unset --path must stay unset so it resolves on
      // the remote (its home directory), not to this machine's cwd.
      const workspacePath = options.path ?? (options.host !== undefined ? undefined : getDefaultWorkspacePath());

      const session = await manager.createSession({
        path: workspacePath,
        cli: options.cli,
        description: options.description,
        mode: options.mode,
        model: options.model,
        host: options.host,
        championId: options.id
      });

      if (options.json) {
        io.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
        return;
      }

      if (options.quiet) {
        io.stdout.write(`${session.championId}\n`);
        return;
      }

      const where = session.host ? ` on ${session.host}` : '';
      io.stdout.write(`Created session ${session.championId}${where}\n`);
    });

  program
    .command('resume <task-id>')
    .description('Resume a backend task or thread and create a new active session ID')
    .option('-p, --path <path>', 'Workspace path; optional when the task is in the retired-session index')
    .option('-d, --description <description>', 'Optional session description')
    .addOption(new Option('--cli <cli>', 'Backend for an unindexed task ID').choices(['claude', 'codex', 'grok']))
    .addOption(new Option('-m, --mode <mode>', 'Session mode').choices(['native', 'docker']))
    .option('--model <model>', 'Model override')
    .option('--host <ssh-target>', 'Resume the task on a remote host')
    .option('--id <champion-id>', 'Use this new active session ID')
    .option('--json', 'Print the full session record as JSON')
    .option('-q, --quiet', 'Only print the new session ID')
    .action(async (taskId: string, options: {
      path?: string;
      description?: string;
      cli?: 'claude' | 'codex' | 'grok';
      mode?: 'native' | 'docker';
      model?: string;
      host?: string;
      id?: string;
      json?: boolean;
      quiet?: boolean;
    }) => {
      const resumeTask = requireManagerMethod(manager.resumeTask?.bind(manager), 'Task resume');
      const session = await resumeTask({
        taskId,
        path: options.path,
        description: options.description,
        cli: options.cli,
        mode: options.mode,
        model: options.model,
        host: options.host,
        championId: options.id
      });
      if (options.json) {
        io.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
      } else if (options.quiet) {
        io.stdout.write(`${session.championId}\n`);
      } else {
        io.stdout.write(`Resumed task ${taskId} as ${session.championId}\n`);
      }
    });

  const readStdin = dependencies.readStdin ?? readStdinToEnd;

  const resolveMessagePayload = async (message: string | undefined, file: string | undefined): Promise<string> => {
    if (file && message) {
      throw new CliError('Provide either <message> or --file, not both');
    }

    let payload = message;
    if (file === '-') {
      payload = await readStdin();
    } else if (file) {
      payload = await readFile(path.resolve(file), 'utf8');
    }

    if (!payload || payload.trim().length === 0) {
      throw new CliError('Message is required. Use <message> or --file <path>.');
    }

    return payload;
  };

  program
    .command('send <id> [message]')
    .description('Send a message to a session')
    .option('-f, --file <filePath>', 'Read message content from a file (use - for stdin)')
    .option('--from <session-id>', 'Source session for replies and correlation')
    .option('--idempotency-key <key>', 'Return the existing message when this key is retried for the same target')
    .option('--reply-to <message-id>', 'Connect this message to an earlier message')
    .option('--json', 'Output the durable message record as JSON')
    .action(async (id: string, message: string | undefined, options: {
      file?: string;
      from?: string;
      idempotencyKey?: string;
      replyTo?: string;
      json?: boolean;
    }) => {
      const payload = await resolveMessagePayload(message, options.file);
      const hasQueueOptions = options.from !== undefined ||
        options.idempotencyKey !== undefined ||
        options.replyTo !== undefined;
      const receipt = hasQueueOptions
        ? await manager.sendMessage(id, payload, {
          sourceSessionId: options.from,
          idempotencyKey: options.idempotencyKey,
          replyToMessageId: options.replyTo
        })
        : await manager.sendMessage(id, payload);
      if (options.json && receipt) {
        io.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      } else if (receipt) {
        io.stdout.write(`Queued message ${receipt.id} for ${id} (${receipt.status})\n`);
      } else {
        io.stdout.write(`Sent message to ${id}\n`);
      }
    });

  program
    .command('ask <id> [message]')
    .description('Send a message, wait for the reply, and print it (send + wait + last-message in one step)')
    .option('-f, --file <filePath>', 'Read message content from a file (use - for stdin)')
    .option('-t, --timeout <seconds>', 'Timeout in seconds', '300')
    .option('--from <session-id>', 'Source session for replies and correlation')
    .option('--idempotency-key <key>', 'Deduplicate a retried request')
    .action(async (id: string, message: string | undefined, options: {
      file?: string;
      timeout: string;
      from?: string;
      idempotencyKey?: string;
    }) => {
      const payload = await resolveMessagePayload(message, options.file);
      const timeoutSeconds = parsePositiveInteger(options.timeout, '--timeout');

      const receipt = options.from !== undefined || options.idempotencyKey !== undefined
        ? await manager.sendMessage(id, payload, {
          sourceSessionId: options.from,
          idempotencyKey: options.idempotencyKey
        })
        : await manager.sendMessage(id, payload);
      if (receipt && manager.waitForQueuedMessage) {
        const queuedResult = await manager.waitForQueuedMessage(receipt.id, { timeoutSeconds }, id);
        if (queuedResult.timedOut) {
          throw new CliError(`Timed out waiting for message ${receipt.id} after ${timeoutSeconds}s`, 124);
        }
        if (queuedResult.message.status === 'failed') {
          throw new CliError(queuedResult.message.error ?? `Message ${receipt.id} failed`);
        }
        if (queuedResult.message.status === 'cancelled') {
          throw new CliError(`Message ${receipt.id} was cancelled`);
        }
        if (queuedResult.message.result) io.stdout.write(`${queuedResult.message.result}\n`);
        return;
      }
      const result = await manager.waitForSession(id, { timeoutSeconds });
      if (result.timedOut) {
        throw new CliError(
          `Timed out waiting for ${id} after ${timeoutSeconds}s (the agent keeps working; ` +
          `use 'wait ${id}' then 'last-message ${id}' to pick up the reply)`,
          124
        );
      }

      const blocks = await manager.getLastAssistantTextBlocks(id, 1);
      if (blocks.length === 0) {
        return;
      }

      io.stdout.write(`${blocks.join('\n\n')}\n`);
    });

  program
    .command('messages [session-id]')
    .description('List durable messages')
    .option('--host <ssh-target>', 'List messages stored on a remote host')
    .option('--status <statuses>', 'Comma-separated message states')
    .option('--limit <count>', 'Maximum rows', '100')
    .option('--json', 'Output machine-readable JSON')
    .action(async (sessionId: string | undefined, options: { host?: string; status?: string; limit: string; json?: boolean }) => {
      const listMessages = requireManagerMethod(manager.listQueuedMessages?.bind(manager), 'Durable messages');
      const rows = await listMessages(
        sessionId,
        parseMessageStatuses(options.status),
        parsePositiveInteger(options.limit, '--limit'),
        options.host
      );
      if (options.json) {
        io.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      if (rows.length === 0) {
        io.stdout.write('No messages\n');
        return;
      }
      for (const row of rows) {
        io.stdout.write(`${row.id}\t${row.status}\t${row.targetSessionId}\t${row.createdAt}\n`);
      }
    });

  const messageCommand = program.command('message').description('Inspect or control one durable message');

  messageCommand
    .command('show <message-id>')
    .option('--session <session-id>', 'Route the request through this remote session host')
    .action(async (messageId: string, options: { session?: string }) => {
      const getMessage = requireManagerMethod(manager.getQueuedMessage?.bind(manager), 'Durable messages');
      const message = await getMessage(messageId, options.session);
      if (!message) throw new CliError(`Message not found: ${messageId}`);
      io.stdout.write(`${JSON.stringify(message, null, 2)}\n`);
    });

  messageCommand
    .command('wait <message-id>')
    .option('--session <session-id>', 'Route the request through this remote session host')
    .option('-t, --timeout <seconds>', 'Timeout in seconds', '300')
    .option('-i, --interval <seconds>', 'Polling interval in seconds', '1')
    .action(async (messageId: string, options: { session?: string; timeout: string; interval: string }) => {
      const waitMessage = requireManagerMethod(manager.waitForQueuedMessage?.bind(manager), 'Durable messages');
      const result = await waitMessage(messageId, {
        timeoutSeconds: parsePositiveInteger(options.timeout, '--timeout'),
        intervalSeconds: parsePositiveNumber(options.interval, '--interval')
      }, options.session);
      if (result.timedOut) throw new CliError(`Timed out waiting for message ${messageId}`, 124);
      io.stdout.write(`${JSON.stringify(result.message, null, 2)}\n`);
    });

  messageCommand
    .command('cancel <message-id>')
    .option('--session <session-id>', 'Route the request through this remote session host')
    .action(async (messageId: string, options: { session?: string }) => {
      const cancel = requireManagerMethod(manager.cancelQueuedMessage?.bind(manager), 'Durable messages');
      io.stdout.write(`${JSON.stringify(await cancel(messageId, options.session), null, 2)}\n`);
    });

  messageCommand
    .command('retry <message-id>')
    .option('--session <session-id>', 'Route the request through this remote session host')
    .action(async (messageId: string, options: { session?: string }) => {
      const retry = requireManagerMethod(manager.retryQueuedMessage?.bind(manager), 'Durable messages');
      io.stdout.write(`${JSON.stringify(await retry(messageId, options.session), null, 2)}\n`);
    });

  messageCommand
    .command('reply <message-id> [message]')
    .option('-f, --file <filePath>', 'Read message content from a file (use - for stdin)')
    .option('--session <session-id>', 'Route the request through this remote session host')
    .option('--idempotency-key <key>', 'Deduplicate a retried reply')
    .action(async (messageId: string, message: string | undefined, options: {
      file?: string;
      session?: string;
      idempotencyKey?: string;
    }) => {
      const reply = requireManagerMethod(manager.replyToQueuedMessage?.bind(manager), 'Durable messages');
      const payload = await resolveMessagePayload(message, options.file);
      io.stdout.write(`${JSON.stringify(await reply(
        messageId,
        payload,
        { idempotencyKey: options.idempotencyKey },
        options.session
      ), null, 2)}\n`);
    });

  program
    .command('schedules')
    .description('List schedules on this host')
    .option('--host <ssh-target>', 'List schedules on a remote host')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: { host?: string; json?: boolean }) => {
      const listSchedules = requireManagerMethod(manager.listSchedules?.bind(manager), 'Schedules');
      const schedules = await listSchedules(options.host);
      if (options.json) {
        io.stdout.write(`${JSON.stringify(schedules, null, 2)}\n`);
        return;
      }
      if (schedules.length === 0) {
        io.stdout.write('No schedules\n');
        return;
      }
      for (const schedule of schedules) {
        io.stdout.write(`${schedule.id}\t${schedule.status}\t${schedule.name}\t${schedule.nextRunAt}\n`);
      }
    });

  const scheduleCommand = program.command('schedule').description('Create or control a schedule');

  scheduleCommand
    .command('create')
    .requiredOption('--name <name>', 'Schedule name')
    .requiredOption('--cron <expression>', 'Cron expression')
    .option('--timezone <iana-zone>', 'IANA time zone')
    .option('--session <session-id>', 'Return to this session task on each run')
    .option('--new-session', 'Create a new session for every run')
    .option('--host <ssh-target>', 'Store a new-session schedule on this remote host')
    .option('-p, --path <path>', 'Workspace path for new sessions')
    .addOption(new Option('--cli <cli>', 'New-session backend').choices(['claude', 'codex', 'grok']).default('claude'))
    .addOption(new Option('-m, --mode <mode>', 'New-session mode').choices(['native', 'docker']).default('native'))
    .option('--model <model>', 'New-session model override')
    .option('--description <description>', 'New-session description')
    .option('--message <message>', 'Message to send on each run')
    .option('-f, --file <filePath>', 'Read the scheduled message from a file (use - for stdin)')
    .addOption(new Option('--misfire <policy>', 'Downtime behavior').choices(['latest', 'skip']).default('latest'))
    .addOption(new Option('--overlap <policy>', 'Behavior while an earlier run is active').choices(['skip', 'queue']).default('skip'))
    .option('--max-lateness <duration>', 'Do not run an obsolete occurrence after this delay', '1h')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: {
      name: string;
      cron: string;
      timezone?: string;
      session?: string;
      newSession?: boolean;
      host?: string;
      path?: string;
      cli: 'claude' | 'codex' | 'grok';
      mode: 'native' | 'docker';
      model?: string;
      description?: string;
      message?: string;
      file?: string;
      misfire: 'latest' | 'skip';
      overlap: 'skip' | 'queue';
      maxLateness: string;
      json?: boolean;
    }) => {
      if ((options.session ? 1 : 0) + (options.newSession ? 1 : 0) !== 1) {
        throw new CliError('Provide exactly one of --session or --new-session');
      }
      if (options.newSession && !options.path) {
        throw new CliError('--path is required with --new-session');
      }
      const message = await resolveMessagePayload(options.message, options.file);
      const createSchedule = requireManagerMethod(manager.createSchedule?.bind(manager), 'Schedules');
      const newSession: NewSessionTemplate | undefined = options.newSession
        ? {
            path: options.host ? options.path as string : path.resolve(options.path as string),
            cli: options.cli,
            mode: options.mode,
            model: options.model,
            description: options.description
          }
        : undefined;
      const schedule = await createSchedule({
        name: options.name,
        targetSessionId: options.session,
        newSession,
        message,
        cron: options.cron,
        timezone: options.timezone,
        misfirePolicy: options.misfire,
        overlapPolicy: options.overlap,
        maxLatenessMs: parseDurationMs(options.maxLateness, '--max-lateness'),
        host: options.host
      });
      if (options.json) {
        io.stdout.write(`${JSON.stringify(schedule, null, 2)}\n`);
      } else {
        io.stdout.write(`Created schedule ${schedule.id} (${schedule.nextRunAt})\n`);
      }
    });

  scheduleCommand
    .command('show <schedule-id>')
    .action(async (id: string) => {
      const getSchedule = requireManagerMethod(manager.getSchedule?.bind(manager), 'Schedules');
      const schedule = await getSchedule(id);
      if (!schedule) throw new CliError(`Schedule not found: ${id}`);
      io.stdout.write(`${JSON.stringify(schedule, null, 2)}\n`);
    });

  for (const action of ['pause', 'resume', 'delete'] as const) {
    scheduleCommand
      .command(`${action} <schedule-id>`)
      .action(async (id: string) => {
        const method = action === 'pause'
          ? manager.pauseSchedule?.bind(manager)
          : action === 'resume'
            ? manager.resumeSchedule?.bind(manager)
            : manager.deleteSchedule?.bind(manager);
        const run = requireManagerMethod(method, 'Schedules');
        io.stdout.write(`${JSON.stringify(await run(id), null, 2)}\n`);
      });
  }

  scheduleCommand
    .command('run <schedule-id>')
    .description('Run a schedule immediately')
    .action(async (id: string) => {
      const runNow = requireManagerMethod(manager.runScheduleNow?.bind(manager), 'Schedules');
      io.stdout.write(`${JSON.stringify(await runNow(id), null, 2)}\n`);
    });

  program
    .command('runs [schedule-id]')
    .description('List schedule runs')
    .option('--host <ssh-target>', 'List runs stored on a remote host')
    .option('--limit <count>', 'Maximum rows', '100')
    .option('--json', 'Output machine-readable JSON')
    .action(async (scheduleId: string | undefined, options: { host?: string; limit: string; json?: boolean }) => {
      const listRuns = requireManagerMethod(manager.listScheduleRuns?.bind(manager), 'Schedule runs');
      const runs = await listRuns(scheduleId, parsePositiveInteger(options.limit, '--limit'), options.host);
      if (options.json) {
        io.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
        return;
      }
      if (runs.length === 0) {
        io.stdout.write('No runs\n');
        return;
      }
      for (const run of runs) {
        io.stdout.write(`${run.id}\t${run.status}\t${run.scheduleId}\t${run.scheduledFor}\n`);
      }
    });

  program
    .command('run <run-id>')
    .description('Show one schedule run')
    .action(async (id: string) => {
      const getRun = requireManagerMethod(manager.getScheduleRun?.bind(manager), 'Schedule runs');
      const run = await getRun(id);
      if (!run) throw new CliError(`Run not found: ${id}`);
      io.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    });

  program
    .command('automation-tick', { hidden: true })
    .description('Process durable messages, schedules, and automatic cleanup once')
    .action(async () => {
      const tick = requireManagerMethod(manager.runAutomationTick?.bind(manager), 'Automation');
      await tick();
    });

  program
    .command('kill [id]')
    .description('Kill a session and remove it from the store (or bulk-clean with --all / --older-than)')
    .option('--all', 'Kill every active session')
    .option('--older-than <duration>', 'Kill sessions whose last activity is older than e.g. 30m, 72h, 7d')
    .action(async (id: string | undefined, options: { all?: boolean; olderThan?: string }) => {
      const selectors = [id !== undefined, options.all === true, options.olderThan !== undefined].filter(Boolean).length;
      if (selectors !== 1) {
        throw new CliError('Provide exactly one of <id>, --all, or --older-than <duration>');
      }

      if (id !== undefined) {
        await manager.killSession(id);
        io.stdout.write(`Killed session ${id}\n`);
        return;
      }

      const cutoffMs = options.olderThan !== undefined
        ? Date.now() - parseDurationMs(options.olderThan, '--older-than')
        : undefined;

      const sessions = await manager.listSessions();
      const targets = sessions.filter((session) => {
        if (cutoffMs === undefined) {
          return true;
        }
        const lastUsed = Date.parse(session.lastUsed);
        return Number.isFinite(lastUsed) && lastUsed < cutoffMs;
      });

      if (targets.length === 0) {
        io.stdout.write('No matching sessions to kill\n');
        return;
      }

      for (const session of targets) {
        await manager.killSession(session.championId);
        io.stdout.write(`Killed session ${session.championId}\n`);
      }
      io.stdout.write(`Killed ${targets.length} session${targets.length === 1 ? '' : 's'}\n`);
    });

  program
    .command('list')
    .description('List active sessions')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const sessions = await manager.listSessions();
      if (options.json) {
        io.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
        return;
      }

      if (sessions.length === 0) {
        io.stdout.write('No active sessions\n');
        return;
      }

      io.stdout.write(`${formatSessionsTable(sessions)}\n`);
    });

  program
    .command('last-message <id>')
    .description('Get the last assistant message blocks from transcript')
    .option('-n, --count <count>', 'Number of assistant text blocks', '1')
    .option('--json', 'Output blocks as a JSON array (lossless — text mode joins blocks with blank lines)')
    .action(async (id: string, options: { count: string; json?: boolean }) => {
      const count = parsePositiveInteger(options.count, '--count');
      const blocks = await manager.getLastAssistantTextBlocks(id, count);

      if (options.json) {
        io.stdout.write(`${JSON.stringify(blocks)}\n`);
        return;
      }

      if (blocks.length === 0) {
        return;
      }

      io.stdout.write(`${blocks.join('\n\n')}\n`);
    });

  program
    .command('status <id>')
    .description('Get inferred session status: idle | working | waiting_for_input')
    .action(async (id: string) => {
      const status = await manager.getSessionStatus(id);
      io.stdout.write(`${status}\n`);
    });

  program
    .command('wait <id>')
    .description('Wait until assistant responds to latest user message (or, with --goal, until the goal settles)')
    .option('-t, --timeout <seconds>', 'Timeout in seconds', '300')
    .option('-i, --interval <seconds>', 'Polling interval in seconds', '2')
    .option(
      '--goal',
      'Wait until the session goal reaches a terminal state (complete, paused, blocked, usageLimited, budgetLimited); prints the final status'
    )
    .option(
      '--next-turn',
      'Return as soon as the next turn completes (codex only) — includes server-initiated goal continuation turns'
    )
    .action(async (id: string, options: { timeout: string; interval: string; goal?: boolean; nextTurn?: boolean }) => {
      const timeoutSeconds = parsePositiveInteger(options.timeout, '--timeout');
      const intervalSeconds = parsePositiveNumber(options.interval, '--interval');

      if (options.goal && options.nextTurn) {
        throw new CliError('Use only one of --goal, --next-turn');
      }

      if (options.nextTurn) {
        const nextTurnResult = await manager.waitForSessionNextTurn(id, { timeoutSeconds });
        if (nextTurnResult.timedOut) {
          throw new CliError(`Timed out waiting for the next turn on ${id}`, 124);
        }
        io.stdout.write('completed\n');
        return;
      }

      if (options.goal) {
        const goalResult = await manager.waitForSessionGoal(id, {
          timeoutSeconds,
          intervalSeconds
        });

        if (goalResult.timedOut) {
          throw new CliError(`Timed out waiting for goal on ${id}`, 124);
        }

        io.stdout.write(`${goalResult.goal ? goalResult.goal.status : 'cleared'}\n`);
        return;
      }

      const result = await manager.waitForSession(id, {
        timeoutSeconds,
        intervalSeconds
      });

      if (result.timedOut) {
        throw new CliError(`Timed out waiting for ${id}`, 124);
      }

      io.stdout.write('completed\n');
    });

  program
    .command('goal <id> [objective...]')
    .description(
      'Manage an autonomous goal on a codex session. With an objective, the agent works toward it ' +
      'across turns until complete. Without arguments, shows the current goal.'
    )
    .option('--budget <tokens>', 'Token budget for the goal')
    .option('-f, --file <filePath>', 'Read the objective from a file (use - for stdin)')
    .option('--pause', 'Pause the active goal')
    .option('--resume', 'Resume a paused or blocked goal')
    .option('--clear', 'Clear the goal')
    .option('--json', 'Output machine-readable JSON')
    .action(async (
      id: string,
      objectiveWords: string[],
      options: { budget?: string; file?: string; pause?: boolean; resume?: boolean; clear?: boolean; json?: boolean }
    ) => {
      let objective = objectiveWords.join(' ').trim();
      if (options.file !== undefined) {
        if (objective.length > 0) {
          throw new CliError('Provide either an objective or --file, not both');
        }
        const content = options.file === '-' ? await readStdin() : await readFile(path.resolve(options.file), 'utf8');
        objective = content.trim();
        if (objective.length === 0) {
          throw new CliError('Objective file is empty. Provide a non-empty objective.');
        }
      }
      const actionFlags = [options.pause, options.resume, options.clear].filter(Boolean).length;
      if (actionFlags > 1) {
        throw new CliError('Use only one of --pause, --resume, --clear');
      }
      if (options.clear && (objective.length > 0 || options.budget !== undefined)) {
        throw new CliError('--clear cannot be combined with an objective or --budget');
      }
      if ((options.pause || options.resume) && objective.length > 0) {
        throw new CliError('--pause/--resume cannot be combined with an objective');
      }

      if (options.clear) {
        const cleared = await manager.clearSessionGoal(id);
        if (options.json) {
          io.stdout.write(`${JSON.stringify({ cleared })}\n`);
          return;
        }
        io.stdout.write(cleared ? `Cleared goal for ${id}\n` : `No goal to clear for ${id}\n`);
        return;
      }

      const update: GoalUpdate = {};
      if (objective.length > 0) {
        update.objective = objective;
        // A new objective means "start pursuing it". Without this, setting an
        // objective on a thread whose previous goal completed leaves the goal
        // in 'complete' status and the agent never starts.
        update.status = 'active';
      }
      if (options.pause) {
        update.status = 'paused';
      }
      if (options.resume) {
        update.status = 'active';
      }
      if (options.budget !== undefined) {
        update.tokenBudget = parsePositiveInteger(options.budget, '--budget');
      }

      if (Object.keys(update).length === 0) {
        const goal = await manager.getSessionGoal(id);
        if (options.json) {
          io.stdout.write(`${JSON.stringify(goal ?? null, null, 2)}\n`);
          return;
        }
        if (!goal) {
          io.stdout.write(`No goal set for ${id}\n`);
          return;
        }
        io.stdout.write(`${formatGoal(goal)}\n`);
        return;
      }

      const goal = await manager.setSessionGoal(id, update);
      if (options.json) {
        io.stdout.write(`${JSON.stringify(goal, null, 2)}\n`);
        return;
      }
      io.stdout.write(`${formatGoal(goal)}\n`);
    });

  program
    .command('logs <id>')
    .description('Show full conversation history for a session (human and assistant turns in order)')
    .option('--json', 'Output turns as a JSON array (lossless)')
    .action(async (id: string, options: { json?: boolean }) => {
      const turns = await manager.getSessionLogs(id);

      if (options.json) {
        io.stdout.write(`${JSON.stringify(turns)}\n`);
        return;
      }

      if (turns.length === 0) {
        io.stdout.write('No conversation history available\n');
        return;
      }

      const formatted = turns
        .map((turn) => `[${turn.role.toUpperCase()}]\n${turn.text}`)
        .join('\n\n');
      io.stdout.write(`${formatted}\n`);
    });

  program
    .command('inspect <id>')
    .description('Dump raw stored session record as JSON')
    .action(async (id: string) => {
      const session = await manager.inspectSession(id);
      io.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
    });

  const gatewayCmd = program
    .command('gateway')
    .description('Start the Docker relay gateway HTTP server (or manage the daemon)')
    .option('--port <port>', 'Port to listen on', String(resolveGatewayPort()))
    .action(async (options: { port: string }) => {
      const port = parsePositiveInteger(options.port, '--port');
      await startGatewayServer({ port });
      io.stdout.write(`Gateway listening on port ${port}\n`);
    });

  gatewayCmd
    .command('install')
    .description('Install the gateway as a system daemon (launchd on macOS, systemd on Linux)')
    .option('--port <port>', 'Port for the daemon to listen on', String(resolveGatewayPort()))
    .action(async (options: { port: string }) => {
      const port = parsePositiveInteger(options.port, '--port');
      // Prefer the installed binary on PATH so launchd/systemd can run it as a standalone executable.
      // Fall back to resolveGatewayCliBinary() for local dev runs.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      let binaryPath: string;
      try {
        const { stdout } = await execFileAsync('which', ['dev-sessions']);
        binaryPath = stdout.trim();
      } catch {
        binaryPath = resolveGatewayCliBinary();
      }
      await installGatewayDaemon({ binaryPath, port });
      io.stdout.write(`Gateway daemon installed and started on port ${port}\n`);
      io.stdout.write(`\nNote: On macOS you may need to grant Full Disk Access to:\n`);
      io.stdout.write(`  ${process.execPath}\n`);
      io.stdout.write(`  System Settings → Privacy & Security → Full Disk Access → add the path above\n`);
    });

  gatewayCmd
    .command('uninstall')
    .description('Stop and remove the gateway daemon')
    .action(async () => {
      await uninstallGatewayDaemon();
      io.stdout.write('Gateway daemon uninstalled\n');
    });

  gatewayCmd
    .command('status')
    .description('Print whether the gateway daemon is running and which port it uses')
    .action(async () => {
      const { running, port } = await getGatewayDaemonStatus();
      const state = running ? 'running' : 'stopped';
      io.stdout.write(`Gateway daemon: ${state} (port ${port})\n`);
    });

  program
    .command('install-skill')
    .description('Install the dev-sessions skill for Claude Code and/or Codex CLI')
    .option('--global', 'Install globally (~/.<tool>/skills/)')
    .option('--local', 'Install locally (./.<tool>/skills/)')
    .option('--claude', 'Install for Claude Code')
    .option('--codex', 'Install for Codex CLI')
    .action(async (options: { global?: boolean; local?: boolean; claude?: boolean; codex?: boolean }) => {
      const scope = resolveInstallSkillScope(options);
      const { targets, defaultedToClaude } = await resolveInstallSkillTargets(options, installSkillDependencies);
      const skillsDir = installSkillDependencies.skillsDirectory();
      const skillNames = await installSkillDependencies.listDirectory(skillsDir);
      const installBasePath =
        scope === 'global'
          ? installSkillDependencies.homedir()
          : path.resolve(installSkillDependencies.cwd());

      if (defaultedToClaude) {
        io.stdout.write('No ~/.claude or ~/.codex found; defaulting to Claude Code.\n');
      }

      for (const skillName of skillNames) {
        const sourcePath = path.join(skillsDir, skillName, 'SKILL.md');
        const sourceContent = await installSkillDependencies.readFile(sourcePath, 'utf8');

        for (const target of targets) {
          const destinationDirectory = path.join(installBasePath, `.${target}`, 'skills', skillName);
          const destinationFile = path.join(destinationDirectory, 'SKILL.md');

          await installSkillDependencies.mkdir(destinationDirectory, { recursive: true });
          await installSkillDependencies.writeFile(destinationFile, sourceContent, 'utf8');
          io.stdout.write(`Installed skill: ${skillName} → ${destinationFile}\n`);
        }
      }
    });

  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  manager: SessionManagerLike = createDefaultSessionManager(),
  io: CliIO = { stdout: process.stdout, stderr: process.stderr }
): Promise<number> {
  const program = buildProgram(manager, io);
  program.exitOverride();

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      // Both already wrote their output to stdout; re-printing the error
      // message would duplicate it on stderr.
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
        return 0;
      }

      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }

    const exitCode =
      typeof (error as { exitCode?: unknown }).exitCode === 'number'
        ? (error as { exitCode: number }).exitCode
        : 1;

    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return exitCode;
  }
}
