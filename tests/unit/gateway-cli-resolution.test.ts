import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startGatewayServer } from '../../src/gateway/server';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe('gateway CLI resolution', () => {
  it('runs the durable automation worker while the gateway is active', async () => {
    const executeCommand = vi.fn(async (args: string[]) => ({
      command: ['dev-sessions', ...args], stdout: '', stderr: '', exitCode: 0
    }));
    const started = await startGatewayServer({
      port: 0,
      executeCommand,
      enableCodexStatusProjection: false,
      enableAutomationWorker: true,
      automationTickIntervalMs: 10
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(executeCommand).toHaveBeenCalledWith(['automation-tick']);
    } finally {
      await new Promise<void>((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    }
  });

  const tempDirectories: string[] = [];
  const servers: Server[] = [];
  const originalArgv1 = process.argv[1];

  afterEach(async () => {
    process.argv[1] = originalArgv1;

    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await closeServer(server);
      }
    }

    while (tempDirectories.length > 0) {
      const directory = tempDirectories.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('uses the resolved process script path when no cliBinary is provided', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-gateway-cli-'));
    tempDirectories.push(tempDirectory);

    const cliPath = path.join(tempDirectory, 'dev-sessions-local');
    await writeFile(
      cliPath,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        "if (args[0] === 'list' && args[1] === '--json') {",
        "  process.stdout.write('[]\\n');",
        '  process.exit(0);',
        '}',
        "process.stderr.write(`unexpected args: ${args.join(' ')}\\n`);",
        'process.exit(1);'
      ].join('\n'),
      'utf8'
    );
    await chmod(cliPath, 0o755);

    process.argv[1] = cliPath;

    const started = await startGatewayServer({
      port: 0,
      enableCodexStatusProjection: false,
      enableAutomationWorker: false
    });
    servers.push(started.server);

    const address = started.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/list`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        sessions: [],
        output: expect.objectContaining({
          command: [process.execPath, cliPath, 'list', '--json']
        })
      })
    );
  });

  it('starts and stops an injected Codex status projector with the gateway', async () => {
    const statusProjector = {
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({ state: 'connected' as const, appServerPid: 100 }))
    };
    const started = await startGatewayServer({
      port: 0,
      executeCommand: async (args) => ({
        command: args,
        stdout: '',
        stderr: '',
        exitCode: 0
      }),
      statusProjector
    });

    expect(statusProjector.start).toHaveBeenCalledOnce();
    const response = await fetch(`http://127.0.0.1:${started.port}/health`);
    await expect(response.json()).resolves.toEqual({
      status: 'healthy',
      codexStatusProjection: {
        state: 'connected',
        appServerPid: 100
      }
    });
    await closeServer(started.server);
    await vi.waitFor(() => expect(statusProjector.stop).toHaveBeenCalledOnce());
  });

  it('keeps gateway health available when the status projector cannot start', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const statusProjector = {
      start: vi.fn(() => {
        throw new Error('projection unavailable');
      }),
      stop: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({ state: 'reconnecting' as const, lastError: 'projection unavailable' }))
    };

    try {
      const started = await startGatewayServer({
        port: 0,
        executeCommand: async (args) => ({
          command: args,
          stdout: '',
          stderr: '',
          exitCode: 0
        }),
        statusProjector
      });
      servers.push(started.server);

      const response = await fetch(`http://127.0.0.1:${started.port}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: 'healthy',
        codexStatusProjection: {
          state: 'reconnecting',
          lastError: 'projection unavailable'
        }
      });
      await closeServer(started.server);
      servers.pop();
      await vi.waitFor(() => expect(statusProjector.stop).toHaveBeenCalledOnce());
    } finally {
      warnSpy.mockRestore();
    }
  });
});
