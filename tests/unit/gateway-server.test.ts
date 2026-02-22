import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayApp,
  GatewayCommandError,
  GatewayCommandExecutor,
  GatewayCommandResult
} from '../../src/gateway/server';

function createCommandResult(args: string[], stdout: string): GatewayCommandResult {
  return {
    command: ['dev-sessions', ...args],
    stdout,
    stderr: '',
    exitCode: 0
  };
}

async function startGatewayTestServer(executeCommand: GatewayCommandExecutor): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = createGatewayApp(executeCommand);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const started = app.listen(0, () => {
      resolve(started);
    });
    started.on('error', reject);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () => {
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
  };
}

describe('gateway server', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) {
        await close();
      }
    }
  });

  it('serves health checks', async () => {
    const executeCommand = vi.fn<GatewayCommandExecutor>();
    const server = await startGatewayTestServer(executeCommand);
    closers.push(server.close);

    const response = await fetch(`${server.baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'healthy'
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('creates sessions by shelling to create + list commands', async () => {
    const now = '2026-02-22T00:00:00.000Z';
    const session = {
      championId: 'fizz-top',
      internalId: 'uuid-123',
      cli: 'claude',
      mode: 'docker',
      path: '/host/project',
      description: 'gateway test',
      status: 'active',
      createdAt: now,
      lastUsed: now
    } as const;

    const executeCommand = vi.fn<GatewayCommandExecutor>(async (args) => {
      if (args[0] === 'create') {
        return createCommandResult(args, 'fizz-top\n');
      }

      if (args[0] === 'list') {
        return createCommandResult(args, `${JSON.stringify([session])}\n`);
      }

      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const server = await startGatewayTestServer(executeCommand);
    closers.push(server.close);

    const response = await fetch(`${server.baseUrl}/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        path: '/host/project',
        cli: 'claude',
        mode: 'docker',
        description: 'gateway test'
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe('fizz-top');
    expect(body.session).toEqual(session);
    expect(executeCommand).toHaveBeenNthCalledWith(1, [
      'create',
      '--quiet',
      '--path',
      '/host/project',
      '--cli',
      'claude',
      '--mode',
      'docker',
      '--description',
      'gateway test'
    ]);
    expect(executeCommand).toHaveBeenNthCalledWith(2, ['list', '--json']);
  });

  it('sends messages using --file when provided', async () => {
    const executeCommand = vi.fn<GatewayCommandExecutor>(async (args) => createCommandResult(args, ''));
    const server = await startGatewayTestServer(executeCommand);
    closers.push(server.close);

    const response = await fetch(`${server.baseUrl}/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: 'fizz-top',
        file: '/tmp/brief.md'
      })
    });

    expect(response.status).toBe(200);
    expect(executeCommand).toHaveBeenCalledWith(['send', 'fizz-top', '--file', '/tmp/brief.md']);
  });

  it('returns timeout payload for wait command exit code 124', async () => {
    const executeCommand = vi.fn<GatewayCommandExecutor>(async (args) => {
      throw new GatewayCommandError('wait timed out', {
        command: ['dev-sessions', ...args],
        stdout: '',
        stderr: 'Timed out waiting for fizz-top\n',
        exitCode: 124
      });
    });
    const server = await startGatewayTestServer(executeCommand);
    closers.push(server.close);

    const response = await fetch(`${server.baseUrl}/wait?id=fizz-top&timeout=3`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.waitResult.completed).toBe(false);
    expect(body.waitResult.timedOut).toBe(true);
    expect(body.output.exitCode).toBe(124);
  });

  it('parses last-message output into blocks', async () => {
    const executeCommand = vi.fn<GatewayCommandExecutor>(async (args) =>
      createCommandResult(args, 'first block\n\nsecond block\n')
    );
    const server = await startGatewayTestServer(executeCommand);
    closers.push(server.close);

    const response = await fetch(`${server.baseUrl}/last-message?id=fizz-top&n=2`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.blocks).toEqual(['first block', 'second block']);
    expect(executeCommand).toHaveBeenCalledWith(['last-message', 'fizz-top', '-n', '2']);
  });
});
