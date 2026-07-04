import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultCodexAppServerDaemonManager } from '../../src/backends/codex-appserver';

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe('codex daemon startup', () => {
  let tmpDir = '';
  let statePath = '';
  let logPath = '';
  let listener: Server | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ds-daemon-startup-'));
    statePath = path.join(tmpDir, 'codex-appserver.json');
    logPath = path.join(tmpDir, 'codex-appserver.log');
  });

  afterEach(async () => {
    listener?.close();
    listener = undefined;
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function listenOnEphemeralPort(): Promise<number> {
    return new Promise((resolve) => {
      listener = createServer();
      listener.listen(0, '127.0.0.1', () => {
        resolve((listener!.address() as { port: number }).port);
      });
    });
  }

  it('spawns exactly one daemon when two processes start concurrently', async () => {
    const port = await listenOnEphemeralPort();
    let spawnCount = 0;

    const fakeSpawn = (): ChildProcess => {
      spawnCount += 1;
      // Simulate the daemon logging its listen URL shortly after spawn.
      setTimeout(() => {
        void writeFile(logPath, `listening on ws://127.0.0.1:${port}\n`, 'utf8');
      }, 50);
      return { pid: process.pid, unref: () => undefined } as unknown as ChildProcess;
    };

    // Two managers = two CLI processes sharing the same state file.
    const managerA = new DefaultCodexAppServerDaemonManager(statePath, logPath, fakeSpawn, 5_000);
    const managerB = new DefaultCodexAppServerDaemonManager(statePath, logPath, fakeSpawn, 5_000);

    const [infoA, infoB] = await Promise.all([managerA.ensureServer(), managerB.ensureServer()]);

    expect(spawnCount).toBe(1);
    expect(infoA.port).toBe(port);
    expect(infoB.port).toBe(port);
  });

  it('kills the spawned child when startup fails, and releases the lock', async () => {
    let childPid = 0;
    const fakeSpawn = (): ChildProcess => {
      // A real process that never logs a listen URL — startup must time out.
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      childPid = child.pid as number;
      return child;
    };

    const manager = new DefaultCodexAppServerDaemonManager(statePath, logPath, fakeSpawn, 500);

    await expect(manager.ensureServer()).rejects.toThrow(/Timed out waiting for Codex app-server startup/);
    expect(childPid).toBeGreaterThan(0);
    expect(await waitFor(() => !isProcessRunning(childPid), 2_000)).toBe(true);

    // The startup lock must not leak: a follow-up attempt fails on startup
    // again (fast), not on lock acquisition.
    await expect(manager.ensureServer()).rejects.toThrow(/Timed out waiting for Codex app-server startup/);
  });

  it('recovers a stale startup lock from a crashed process', async () => {
    const port = await listenOnEphemeralPort();
    const lockPath = `${statePath}.startup.lock`;
    await mkdir(lockPath, { recursive: true });
    const staleTime = new Date(Date.now() - 3_600_000);
    await utimes(lockPath, staleTime, staleTime);

    const fakeSpawn = (): ChildProcess => {
      setTimeout(() => {
        void writeFile(logPath, `listening on ws://127.0.0.1:${port}\n`, 'utf8');
      }, 50);
      return { pid: process.pid, unref: () => undefined } as unknown as ChildProcess;
    };

    const manager = new DefaultCodexAppServerDaemonManager(statePath, logPath, fakeSpawn, 5_000);
    const info = await manager.ensureServer();
    expect(info.port).toBe(port);
  });
});
