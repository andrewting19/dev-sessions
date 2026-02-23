import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import pkg from '../package.json';
import { createDefaultSessionManager, CreateSessionOptions, WaitOptions } from './session-manager';
import {
  getGatewayDaemonStatus,
  installGatewayDaemon,
  uninstallGatewayDaemon
} from './gateway/daemon';
import { resolveGatewayCliBinary, resolveGatewayPort, startGatewayServer } from './gateway/server';
import { AgentTurnStatus, StoredSession, WaitResult } from './types';

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
    .option('-p, --path <path>', 'Workspace path to run the agent in', getDefaultWorkspacePath())
    .option('-d, --description <description>', 'Optional description for the session')
    .addOption(
      new Option('--cli <cli>', 'Agent CLI backend')
        .choices(['claude', 'codex'])
        .default('claude')
    )
    .addOption(
      new Option('-m, --mode <mode>', 'Session mode')
        .choices(['yolo', 'native', 'docker'])
        .default('yolo')
    )
    .option('-q, --quiet', 'Only print session ID (for scripts)')
    .action(async (options: {
      path: string;
      description?: string;
      cli: 'claude' | 'codex';
      mode: 'yolo' | 'native' | 'docker';
      quiet?: boolean;
    }) => {
      const session = await manager.createSession({
        path: options.path,
        cli: options.cli,
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
