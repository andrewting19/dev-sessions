import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import pkg from '../package.json';
import { createDefaultSessionManager, CreateSessionOptions, GoalWaitResult, WaitOptions } from './session-manager';
import {
  getGatewayDaemonStatus,
  installGatewayDaemon,
  uninstallGatewayDaemon
} from './gateway/daemon';
import { resolveGatewayCliBinary, resolveGatewayPort, startGatewayServer } from './gateway/server';
import { AgentTurnStatus, GoalUpdate, SessionTurn, StoredSession, ThreadGoal, WaitResult } from './types';

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
  sendMessage(championId: string, message: string): Promise<void>;
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
        .choices(['claude', 'codex'])
        .default('claude')
    )
    .addOption(
      new Option('-m, --mode <mode>', 'Session mode')
        .choices(['native', 'docker'])
        .default('native')
    )
    .option('--model <model>', 'Model override (codex only; defaults to the codex-configured model)')
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
      cli: 'claude' | 'codex';
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
    .action(async (id: string, message: string | undefined, options: { file?: string }) => {
      const payload = await resolveMessagePayload(message, options.file);
      await manager.sendMessage(id, payload);
      io.stdout.write(`Sent message to ${id}\n`);
    });

  program
    .command('ask <id> [message]')
    .description('Send a message, wait for the reply, and print it (send + wait + last-message in one step)')
    .option('-f, --file <filePath>', 'Read message content from a file (use - for stdin)')
    .option('-t, --timeout <seconds>', 'Timeout in seconds', '300')
    .action(async (id: string, message: string | undefined, options: { file?: string; timeout: string }) => {
      const payload = await resolveMessagePayload(message, options.file);
      const timeoutSeconds = parsePositiveInteger(options.timeout, '--timeout');

      await manager.sendMessage(id, payload);
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
    .option('--pause', 'Pause the active goal')
    .option('--resume', 'Resume a paused or blocked goal')
    .option('--clear', 'Clear the goal')
    .option('--json', 'Output machine-readable JSON')
    .action(async (
      id: string,
      objectiveWords: string[],
      options: { budget?: string; pause?: boolean; resume?: boolean; clear?: boolean; json?: boolean }
    ) => {
      const objective = objectiveWords.join(' ').trim();
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
