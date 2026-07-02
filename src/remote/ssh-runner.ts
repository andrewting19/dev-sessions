import { ChildProcess, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ssh itself exits 255 on connection/auth/transport failure. dev-sessions never
// exits 255, so callers can distinguish "network failed" from "session failed".
export const SSH_TRANSPORT_EXIT_CODE = 255;

export class SshTransportError extends Error {
  readonly exitCode = SSH_TRANSPORT_EXIT_CODE;

  constructor(host: string, detail: string) {
    super(`SSH transport failure talking to ${host}${detail ? `: ${detail}` : ''}`);
    this.name = 'SshTransportError';
  }
}

export interface SshRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SshRunOptions {
  stdin?: string;
}

export type SpawnSshProcess = (command: string, args: string[]) => ChildProcess;

export interface SshRunnerOptions {
  spawnProcess?: SpawnSshProcess;
  controlDir?: string;
}

function defaultSpawnSsh(command: string, args: string[]): ChildProcess {
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the command string executed on the remote. The remote sshd runs the
 * user's login shell with `-c <string>`; we wrap in `bash -lc` so login-shell
 * init files run and PATH additions (npm globals, nvm) are picked up.
 */
export function buildRemoteScript(remoteBin: string, args: string[]): string {
  // remoteBin may intentionally be a command with arguments (e.g. "npx dev-sessions"),
  // so it is embedded unquoted; everything else is quoted.
  const inner = [remoteBin, ...args.map(shellQuote)].join(' ');
  return `bash -lc ${shellQuote(inner)}`;
}

export function validateSshHost(host: string): void {
  if (host.trim().length === 0 || host.startsWith('-')) {
    throw new Error(`Invalid SSH host: ${host}`);
  }
}

/**
 * Executes dev-sessions commands on a remote host over ssh. Uses connection
 * multiplexing (ControlMaster) so per-command latency after the first
 * connection is low. Auth is delegated entirely to ssh config; BatchMode
 * ensures commands fail fast instead of hanging on interactive prompts.
 */
export class SshRunner {
  private readonly spawnProcess: SpawnSshProcess;

  private readonly controlDir: string;

  constructor(options: SshRunnerOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? defaultSpawnSsh;
    this.controlDir = options.controlDir ?? path.join(os.homedir(), '.dev-sessions', 'ssh');
  }

  buildSshArgs(host: string): string[] {
    return [
      '-o', 'BatchMode=yes',
      // BatchMode can't answer the first-connection host-key prompt; accept-new
      // keeps first use unattended while still failing hard on changed keys.
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${path.join(this.controlDir, '%C')}`,
      '-o', 'ControlPersist=60s',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      '-o', 'ConnectTimeout=10',
      host
    ];
  }

  async run(host: string, remoteBin: string, args: string[], options: SshRunOptions = {}): Promise<SshRunResult> {
    validateSshHost(host);
    await mkdir(this.controlDir, { recursive: true });

    const sshArgs = [...this.buildSshArgs(host), buildRemoteScript(remoteBin, args)];
    const child = this.spawnProcess('ssh', sshArgs);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    if (child.stdin) {
      if (options.stdin !== undefined) {
        child.stdin.on('error', () => {
          // Remote command may exit before consuming stdin (e.g. usage errors); EPIPE here is not the failure we report.
        });
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', (error) => reject(new SshTransportError(host, error.message)));
      child.on('close', (code) => resolve(code ?? SSH_TRANSPORT_EXIT_CODE));
    });

    const result: SshRunResult = {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8')
    };

    if (exitCode === SSH_TRANSPORT_EXIT_CODE) {
      throw new SshTransportError(host, result.stderr.trim());
    }

    return result;
  }
}
