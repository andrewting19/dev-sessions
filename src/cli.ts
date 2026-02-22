import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { createDefaultSessionManager, CreateSessionOptions, WaitOptions } from './session-manager';
import { AgentTurnStatus, StoredSession, WaitResult } from './types';

interface CliIO {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export interface SessionManagerLike {
  createSession(options: CreateSessionOptions): Promise<StoredSession>;
  sendMessage(championId: string, message: string): Promise<void>;
  killSession(championId: string): Promise<void>;
  listSessions(): Promise<StoredSession[]>;
  getLastAssistantTextBlocks(championId: string, count: number): Promise<string[]>;
  getSessionStatus(championId: string): Promise<AgentTurnStatus>;
  waitForSession(championId: string, options: WaitOptions): Promise<WaitResult>;
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

function getDefaultWorkspacePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.IS_SANDBOX === '1' && typeof env.HOST_PATH === 'string' && env.HOST_PATH.trim().length > 0) {
    return env.HOST_PATH;
  }

  return process.cwd();
}

function formatSessionsTable(sessions: StoredSession[]): string {
  const headers = ['ID', 'CLI', 'MODE', 'STATUS', 'PATH', 'DESCRIPTION', 'LAST USED'];
  const rows = sessions.map((session) => [
    session.championId,
    session.cli,
    session.mode,
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

export function buildProgram(
  manager: SessionManagerLike,
  io: CliIO = { stdout: process.stdout, stderr: process.stderr }
): Command {
  const program = new Command();

  program
    .name('dev-sessions')
    .description('Spawn and manage coding agent sessions')
    .version('0.1.0');

  program
    .command('create')
    .description('Create a new Claude Code tmux session')
    .option('-p, --path <path>', 'Workspace path to run Claude in', getDefaultWorkspacePath())
    .option('-d, --description <description>', 'Optional description for the session')
    .addOption(
      new Option('-m, --mode <mode>', 'Session mode')
        .choices(['yolo', 'native', 'docker'])
        .default('yolo')
    )
    .option('-q, --quiet', 'Only print session ID (for scripts)')
    .action(async (options: {
      path: string;
      description?: string;
      mode: 'yolo' | 'native' | 'docker';
      quiet?: boolean;
    }) => {
      const session = await manager.createSession({
        path: options.path,
        description: options.description,
        mode: options.mode
      });

      if (options.quiet) {
        io.stdout.write(`${session.championId}\n`);
        return;
      }

      io.stdout.write(`Created session ${session.championId}\n`);
    });

  program
    .command('send <id> [message]')
    .description('Send a message to a session')
    .option('-f, --file <filePath>', 'Read message content from a file')
    .action(async (id: string, message: string | undefined, options: { file?: string }) => {
      if (options.file && message) {
        throw new CliError('Provide either <message> or --file, not both');
      }

      let payload = message;
      if (options.file) {
        payload = await readFile(path.resolve(options.file), 'utf8');
      }

      if (!payload || payload.trim().length === 0) {
        throw new CliError('Message is required. Use <message> or --file <path>.');
      }

      await manager.sendMessage(id, payload);
      io.stdout.write(`Sent message to ${id}\n`);
    });

  program
    .command('kill <id>')
    .description('Kill a session and remove it from the store')
    .action(async (id: string) => {
      await manager.killSession(id);
      io.stdout.write(`Killed session ${id}\n`);
    });

  program
    .command('list')
    .description('List active sessions')
    .action(async () => {
      const sessions = await manager.listSessions();
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
    .action(async (id: string, options: { count: string }) => {
      const count = parsePositiveInteger(options.count, '--count');
      const blocks = await manager.getLastAssistantTextBlocks(id, count);

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
    .description('Wait until assistant responds to latest user message')
    .option('-t, --timeout <seconds>', 'Timeout in seconds', '300')
    .option('-i, --interval <seconds>', 'Polling interval in seconds', '2')
    .action(async (id: string, options: { timeout: string; interval: string }) => {
      const timeoutSeconds = parsePositiveInteger(options.timeout, '--timeout');
      const intervalSeconds = parsePositiveInteger(options.interval, '--interval');
      const result = await manager.waitForSession(id, {
        timeoutSeconds,
        intervalSeconds
      });

      if (result.timedOut) {
        throw new CliError(`Timed out waiting for ${id}`, 124);
      }

      io.stdout.write('completed\n');
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
      if (error.code === 'commander.helpDisplayed') {
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
