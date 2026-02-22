import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

    const started = await startGatewayServer({ port: 0 });
    servers.push(started.server);

    const address = started.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/list`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        sessions: [],
        output: expect.objectContaining({
          command: [cliPath, 'list', '--json']
        })
      })
    );
  });
});
