import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  buildRemoteScript,
  shellQuote,
  SshRunner,
  SshTransportError,
  validateSshHost
} from '../../src/remote/ssh-runner';

interface FakeSpawnCall {
  command: string;
  args: string[];
  stdinData: string;
}

function createFakeSpawn(behavior: { exitCode: number; stdout?: string; stderr?: string; spawnError?: Error }): {
  calls: FakeSpawnCall[];
  spawn: (command: string, args: string[]) => ChildProcess;
} {
  const calls: FakeSpawnCall[] = [];

  const spawn = (command: string, args: string[]): ChildProcess => {
    const call: FakeSpawnCall = { command, args, stdinData: '' };
    calls.push(call);

    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        call.stdinData += String(chunk);
        callback();
      }
    });

    Object.assign(child, { stdout, stderr, stdin });

    setImmediate(() => {
      if (behavior.spawnError) {
        child.emit('error', behavior.spawnError);
        return;
      }
      if (behavior.stdout) {
        stdout.emit('data', Buffer.from(behavior.stdout));
      }
      if (behavior.stderr) {
        stderr.emit('data', Buffer.from(behavior.stderr));
      }
      child.emit('close', behavior.exitCode);
    });

    return child;
  };

  return { calls, spawn };
}

describe('shellQuote', () => {
  it('wraps values in single quotes', () => {
    expect(shellQuote('hello')).toBe(`'hello'`);
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`it's a test`)).toBe(`'it'\\''s a test'`);
  });
});

describe('buildRemoteScript', () => {
  it('wraps the command in a bash login shell', () => {
    const script = buildRemoteScript('dev-sessions', ['status', 'fizz-top']);
    expect(script).toBe(`bash -lc 'dev-sessions '\\''status'\\'' '\\''fizz-top'\\'''`);
  });

  it('leaves remoteBin unquoted so it can be a command with arguments', () => {
    const script = buildRemoteScript('npx dev-sessions', ['list', '--json']);
    // remoteBin appears verbatim (word-splittable), unlike the quoted args after it.
    expect(script.startsWith(`bash -lc 'npx dev-sessions `)).toBe(true);
  });

  it('survives both shell parses without splitting or expanding hostile arguments', async () => {
    // sshd hands our script to the login shell, which runs `bash -lc <inner>` —
    // two parse layers. Emulate that locally and confirm arguments round-trip.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const hostile = `bob's "task" with $HOME, \`backticks\`, and\nnewlines`;
    const script = buildRemoteScript('printf', ['%s', hostile]);
    const { stdout } = await execFileAsync('sh', ['-c', script]);

    expect(stdout).toBe(hostile);
  });
});

describe('validateSshHost', () => {
  it('rejects empty hosts', () => {
    expect(() => validateSshHost('  ')).toThrow(/Invalid SSH host/);
  });

  it('rejects hosts that look like flags', () => {
    expect(() => validateSshHost('-oProxyCommand=evil')).toThrow(/Invalid SSH host/);
  });

  it('accepts config aliases and user@host forms', () => {
    expect(() => validateSshHost('buildbox')).not.toThrow();
    expect(() => validateSshHost('andrew@10.0.0.5')).not.toThrow();
  });
});

describe('SshRunner', () => {
  let controlDir: string;

  beforeEach(async () => {
    controlDir = await mkdtemp(path.join(os.tmpdir(), 'ds-ssh-test-'));
  });

  afterEach(async () => {
    await rm(controlDir, { recursive: true, force: true });
  });

  it('invokes ssh with multiplexing and batch-mode options', async () => {
    const fake = createFakeSpawn({ exitCode: 0, stdout: 'idle\n' });
    const runner = new SshRunner({ spawnProcess: fake.spawn, controlDir });

    const result = await runner.run('buildbox', 'dev-sessions', ['status', 'fizz-top']);

    expect(result).toEqual({ exitCode: 0, stdout: 'idle\n', stderr: '' });
    const args = fake.calls[0].args;
    expect(fake.calls[0].command).toBe('ssh');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('ControlMaster=auto');
    expect(args).toContain('ControlPersist=60s');
    expect(args).toContain('buildbox');
    expect(args[args.length - 1]).toContain('dev-sessions');
    expect(args[args.length - 1]).toContain('status');
  });

  it('streams stdin content to the remote command', async () => {
    const fake = createFakeSpawn({ exitCode: 0 });
    const runner = new SshRunner({ spawnProcess: fake.spawn, controlDir });

    await runner.run('buildbox', 'dev-sessions', ['send', 'fizz-top', '--file', '-'], {
      stdin: 'multi\nline\npayload with \'quotes\' and "doubles"'
    });

    expect(fake.calls[0].stdinData).toBe('multi\nline\npayload with \'quotes\' and "doubles"');
  });

  it('passes through non-zero remote exit codes', async () => {
    const fake = createFakeSpawn({ exitCode: 124, stderr: 'Timed out waiting for fizz-top\n' });
    const runner = new SshRunner({ spawnProcess: fake.spawn, controlDir });

    const result = await runner.run('buildbox', 'dev-sessions', ['wait', 'fizz-top']);

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('Timed out');
  });

  it('throws SshTransportError on ssh exit code 255', async () => {
    const fake = createFakeSpawn({ exitCode: 255, stderr: 'ssh: connect to host buildbox port 22: Connection refused\n' });
    const runner = new SshRunner({ spawnProcess: fake.spawn, controlDir });

    await expect(runner.run('buildbox', 'dev-sessions', ['list'])).rejects.toMatchObject({
      name: 'SshTransportError',
      exitCode: 255
    });
  });

  it('throws SshTransportError when ssh cannot be spawned', async () => {
    const fake = createFakeSpawn({ exitCode: 0, spawnError: new Error('spawn ssh ENOENT') });
    const runner = new SshRunner({ spawnProcess: fake.spawn, controlDir });

    await expect(runner.run('buildbox', 'dev-sessions', ['list'])).rejects.toBeInstanceOf(SshTransportError);
  });

  it('rejects hosts that look like flags before spawning', async () => {
    const fake = createFakeSpawn({ exitCode: 0 });
    const runner = new SshRunner({ spawnProcess: fake.spawn, controlDir });

    await expect(runner.run('-oProxyCommand=evil', 'dev-sessions', ['list'])).rejects.toThrow(/Invalid SSH host/);
    expect(fake.calls).toHaveLength(0);
  });
});
