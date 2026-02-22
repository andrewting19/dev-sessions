import { execFile, execFileSync, ExecFileException } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { StoredSession } from '../../src/types';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export const DEV_TEST_TMUX_PREFIX = 'dev-test-';
export const CLI_ENTRYPOINT_PATH = path.resolve('dist/index.js');

export const TMUX_AVAILABLE = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function getErrorOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  return '';
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...options.env
      },
      encoding: 'utf8',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER
    });

    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error: unknown) {
    const execError = error as ExecFileException & {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };

    return {
      code: typeof execError.code === 'number' ? execError.code : 1,
      stdout: getErrorOutput(execError.stdout),
      stderr: getErrorOutput(execError.stderr)
    };
  }
}

export async function runDevSessionsCli(
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return runCommand('node', [CLI_ENTRYPOINT_PATH, ...args], options);
}

export async function runTmux(args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  return runCommand('tmux', args, { timeoutMs });
}

export async function sessionExists(tmuxSessionName: string): Promise<boolean> {
  const result = await runTmux(['has-session', '-t', tmuxSessionName], 5_000);
  return result.code === 0;
}

export async function listTmuxSessions(): Promise<string[]> {
  const result = await runTmux(['list-sessions', '-F', '#{session_name}'], 5_000);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function cleanupPrefixedTmuxSessions(prefix: string = DEV_TEST_TMUX_PREFIX): Promise<void> {
  const sessions = await listTmuxSessions();
  const targetSessions = sessions.filter((session) => session.startsWith(prefix));

  await Promise.all(
    targetSessions.map(async (sessionName) => {
      await runTmux(['kill-session', '-t', sessionName], 5_000);
    })
  );
}

export async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number = 10_000,
  intervalMs: number = 200
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const passed = await condition();
    if (passed) {
      return true;
    }

    await sleep(intervalMs);
  }

  return false;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface SessionStoreFile {
  version: number;
  sessions: StoredSession[];
}

export function getStorePath(homeDir: string): string {
  return path.join(homeDir, '.dev-sessions', 'sessions.json');
}

export async function readStoreSessions(homeDir: string): Promise<StoredSession[]> {
  try {
    const raw = await readFile(getStorePath(homeDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionStoreFile>;
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export async function writeStoreSessions(homeDir: string, sessions: StoredSession[]): Promise<void> {
  const storePath = getStorePath(homeDir);
  await mkdir(path.dirname(storePath), { recursive: true });

  const payload: SessionStoreFile = {
    version: 1,
    sessions
  };

  await writeFile(storePath, JSON.stringify(payload, null, 2), 'utf8');
}
