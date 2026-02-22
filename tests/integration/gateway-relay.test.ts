import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGatewayApp,
  GatewayCommandError,
  GatewayCommandExecutor,
  GatewayCommandResult
} from '../../src/gateway/server';
import { runDevSessionsCli } from './helpers';

interface RelayContext {
  rootDir: string;
  homeDir: string;
  workspaceDir: string;
  baseUrl: string;
  closeServer: () => Promise<void>;
  executeCalls: string[][];
}

function createCommandResult(args: string[], stdout: string): GatewayCommandResult {
  return {
    command: ['dev-sessions', ...args],
    stdout,
    stderr: '',
    exitCode: 0
  };
}

async function startGatewayServer(executeCommand: GatewayCommandExecutor): Promise<{
  baseUrl: string;
  closeServer: () => Promise<void>;
}> {
  const app = createGatewayApp(executeCommand);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const started = app.listen(0, () => {
      resolve(started);
    });
    started.on('error', reject);
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    closeServer: async () => {
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

describe('gateway relay integration', () => {
  let context: RelayContext | undefined;

  beforeEach(async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-gateway-relay-'));
    const homeDir = path.join(rootDir, 'home');
    const workspaceDir = path.join(rootDir, 'workspace');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const sessions = new Map<string, {
      championId: string;
      internalId: string;
      cli: 'claude';
      mode: 'native' | 'yolo' | 'docker';
      path: string;
      status: 'active';
      createdAt: string;
      lastUsed: string;
    }>();
    const executeCalls: string[][] = [];

    const executeCommand: GatewayCommandExecutor = async (args) => {
      executeCalls.push(args);

      if (args[0] === 'create') {
        const sessionId = 'fizz-top';
        const now = '2026-02-22T00:00:00.000Z';
        const pathIndex = args.indexOf('--path');
        const modeIndex = args.indexOf('--mode');
        const workspacePath = pathIndex >= 0 ? args[pathIndex + 1] : '/host/project';
        const mode = modeIndex >= 0 ? (args[modeIndex + 1] as 'native' | 'yolo' | 'docker') : 'yolo';
        sessions.set(sessionId, {
          championId: sessionId,
          internalId: 'uuid-fizz-top',
          cli: 'claude',
          mode,
          path: workspacePath,
          status: 'active',
          createdAt: now,
          lastUsed: now
        });
        return createCommandResult(args, `${sessionId}\n`);
      }

      if (args[0] === 'send') {
        if (!sessions.has(args[1])) {
          throw new GatewayCommandError(`Command failed: dev-sessions send ${args[1]}`, {
            command: ['dev-sessions', ...args],
            stdout: '',
            stderr: `Session not found: ${args[1]}\n`,
            exitCode: 1
          });
        }
        return createCommandResult(args, '');
      }

      if (args[0] === 'kill') {
        sessions.delete(args[1]);
        return createCommandResult(args, '');
      }

      if (args[0] === 'list') {
        return createCommandResult(args, `${JSON.stringify([...sessions.values()])}\n`);
      }

      if (args[0] === 'status') {
        if (!sessions.has(args[1])) {
          throw new GatewayCommandError(`Command failed: dev-sessions status ${args[1]}`, {
            command: ['dev-sessions', ...args],
            stdout: '',
            stderr: `Session not found: ${args[1]}\n`,
            exitCode: 1
          });
        }
        return createCommandResult(args, 'idle\n');
      }

      if (args[0] === 'wait') {
        return createCommandResult(args, 'completed\n');
      }

      if (args[0] === 'last-message') {
        return createCommandResult(args, 'latest message from host\n');
      }

      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };

    const server = await startGatewayServer(executeCommand);
    context = {
      rootDir,
      homeDir,
      workspaceDir,
      baseUrl: server.baseUrl,
      closeServer: server.closeServer,
      executeCalls
    };
  });

  afterEach(async () => {
    if (!context) {
      return;
    }

    await context.closeServer();
    await rm(context.rootDir, { recursive: true, force: true });
    context = undefined;
  });

  it('routes sandbox CLI commands through gateway and maps create path to HOST_PATH', async () => {
    if (!context) {
      throw new Error('Missing gateway relay integration context');
    }

    const messageFile = path.join(context.workspaceDir, 'briefing.md');
    await writeFile(messageFile, 'message from file', 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: context.homeDir,
      IS_SANDBOX: '1',
      HOST_PATH: '/host/project',
      DEV_SESSIONS_GATEWAY_URL: context.baseUrl
    };

    const createResult = await runDevSessionsCli(['create', '--mode', 'native', '--quiet'], {
      env,
      cwd: context.workspaceDir
    });
    expect(createResult.code).toBe(0);
    expect(createResult.stdout.trim()).toBe('fizz-top');

    const sendInlineResult = await runDevSessionsCli(['send', 'fizz-top', 'hello host'], {
      env,
      cwd: context.workspaceDir
    });
    expect(sendInlineResult.code).toBe(0);

    const sendFileResult = await runDevSessionsCli(['send', 'fizz-top', '--file', messageFile], {
      env,
      cwd: context.workspaceDir
    });
    expect(sendFileResult.code).toBe(0);

    const listResult = await runDevSessionsCli(['list', '--json'], {
      env,
      cwd: context.workspaceDir
    });
    expect(listResult.code).toBe(0);
    expect(JSON.parse(listResult.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          championId: 'fizz-top',
          path: '/host/project',
          mode: 'native'
        })
      ])
    );

    const statusResult = await runDevSessionsCli(['status', 'fizz-top'], {
      env,
      cwd: context.workspaceDir
    });
    expect(statusResult.code).toBe(0);
    expect(statusResult.stdout.trim()).toBe('idle');

    const waitResult = await runDevSessionsCli(['wait', 'fizz-top', '--timeout', '4', '--interval', '2'], {
      env,
      cwd: context.workspaceDir
    });
    expect(waitResult.code).toBe(0);
    expect(waitResult.stdout.trim()).toBe('completed');

    const lastMessageResult = await runDevSessionsCli(['last-message', 'fizz-top', '--count', '1'], {
      env,
      cwd: context.workspaceDir
    });
    expect(lastMessageResult.code).toBe(0);
    expect(lastMessageResult.stdout.trim()).toBe('latest message from host');

    const killResult = await runDevSessionsCli(['kill', 'fizz-top'], {
      env,
      cwd: context.workspaceDir
    });
    expect(killResult.code).toBe(0);

    const listAfterKill = await runDevSessionsCli(['list', '--json'], {
      env,
      cwd: context.workspaceDir
    });
    expect(listAfterKill.code).toBe(0);
    expect(JSON.parse(listAfterKill.stdout)).toEqual([]);

    expect(context.executeCalls).toEqual(
      expect.arrayContaining([
        ['create', '--quiet', '--path', '/host/project', '--cli', 'claude', '--mode', 'native'],
        ['send', 'fizz-top', 'hello host'],
        ['send', 'fizz-top', 'message from file'],
        ['status', 'fizz-top'],
        ['wait', 'fizz-top', '--timeout', '4', '--interval', '2'],
        ['last-message', 'fizz-top', '-n', '1'],
        ['kill', 'fizz-top']
      ])
    );
  });

  it('surfaces timeout and missing-session errors through gateway mode', async () => {
    if (!context) {
      throw new Error('Missing gateway relay integration context');
    }

    const executeCalls = context.executeCalls;
    await context.closeServer();

    const timeoutExecutor: GatewayCommandExecutor = async (args) => {
      executeCalls.push(args);

      if (args[0] === 'create') {
        return createCommandResult(args, 'fizz-top\n');
      }

      if (args[0] === 'list') {
        return createCommandResult(
          args,
          `${JSON.stringify([{ championId: 'fizz-top', internalId: 'uuid-fizz-top', cli: 'claude', mode: 'native', path: '/host/project', status: 'active', createdAt: '2026-02-22T00:00:00.000Z', lastUsed: '2026-02-22T00:00:00.000Z' }])}\n`
        );
      }

      if (args[0] === 'wait') {
        throw new GatewayCommandError('wait timed out', {
          command: ['dev-sessions', ...args],
          stdout: '',
          stderr: 'Timed out waiting for fizz-top\n',
          exitCode: 124
        });
      }

      if (args[0] === 'status') {
        throw new GatewayCommandError('Command failed: dev-sessions status missing-id', {
          command: ['dev-sessions', ...args],
          stdout: '',
          stderr: 'Session not found: missing-id\n',
          exitCode: 1
        });
      }

      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };

    const timeoutServer = await startGatewayServer(timeoutExecutor);
    context.baseUrl = timeoutServer.baseUrl;
    context.closeServer = timeoutServer.closeServer;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: context.homeDir,
      IS_SANDBOX: '1',
      HOST_PATH: '/host/project',
      DEV_SESSIONS_GATEWAY_URL: context.baseUrl
    };

    const createResult = await runDevSessionsCli(['create', '--mode', 'native', '--quiet'], {
      env,
      cwd: context.workspaceDir
    });
    expect(createResult.code).toBe(0);

    const waitResult = await runDevSessionsCli(['wait', 'fizz-top', '--timeout', '2'], {
      env,
      cwd: context.workspaceDir
    });
    expect(waitResult.code).toBe(124);
    expect(waitResult.stderr).toContain('Timed out waiting for fizz-top');

    const missingStatusResult = await runDevSessionsCli(['status', 'missing-id'], {
      env,
      cwd: context.workspaceDir
    });
    expect(missingStatusResult.code).toBe(1);
    expect(missingStatusResult.stderr).toContain('Command failed: dev-sessions status missing-id');
  });
});
