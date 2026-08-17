import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DefaultGrokAppServerDaemonManager,
  GrokAcpClient,
  GrokAppServerInfo
} from '../../src/backends/grok-appserver';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('DefaultGrokAppServerDaemonManager', () => {
  it('starts a detached loopback server and keeps its secret out of argv', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-grok-daemon-'));
    const statePath = path.join(temp, 'state.json');
    const logPath = path.join(temp, 'server.log');
    let spawnedArgs: string[] = [];
    let spawnedSecret = '';

    const manager = new DefaultGrokAppServerDaemonManager(
      statePath,
      logPath,
      (args, options) => {
        spawnedArgs = [...args];
        spawnedSecret = options?.env?.GROK_AGENT_SECRET as string;
        const bind = args[args.indexOf('--bind') + 1];
        const port = Number(bind.split(':').at(-1));
        return spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1')`], options);
      },
      5_000
    );
    cleanups.push(async () => {
      await manager.stopServer();
      await rm(temp, { recursive: true, force: true });
    });

    const server = await manager.ensureServer();
    expect(server.url).toBe(`ws://127.0.0.1:${server.port}/ws`);
    expect(spawnedArgs).toEqual([
      'agent', '--always-approve', 'serve', '--bind', `127.0.0.1:${server.port}`
    ]);
    expect(spawnedArgs.join(' ')).not.toContain(spawnedSecret);
    expect(spawnedSecret).toMatch(/^[a-f0-9]{64}$/);

    const stateFile = JSON.parse(await readFile(statePath, 'utf8')) as { secret: string };
    expect(stateFile.secret).toBe(spawnedSecret);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);

    // A stale permissive mode must not affect the assertion above or cleanup.
    await chmod(statePath, 0o600);
  });
});

describe('GrokAcpClient', () => {
  it('uses ACP for auth, model selection, replay, status, and prompt acceptance', async () => {
    const secret = 'test-secret';
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const address = wss.address();
    if (typeof address === 'string') {
      throw new Error('expected TCP address');
    }
    cleanups.push(async () => new Promise<void>((resolve) => wss.close(() => resolve())));

    wss.on('connection', (socket, request) => {
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        calls.push({ method: message.method, params: message.params });
        const respond = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));

        if (message.method === 'initialize') {
          respond({
            authMethods: [{ id: 'cached_token' }],
            _meta: {
              defaultAuthMethodId: 'cached_token',
              modelState: { currentModelId: 'grok-4.6' }
            }
          });
        } else if (message.method === 'authenticate') {
          respond({});
        } else if (message.method === 'session/new') {
          respond({ sessionId: 'session-1' });
        } else if (message.method === 'session/load') {
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'session-1',
              update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } }
            }
          }));
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'session-1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
            }
          }));
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'x.ai/session/update',
            params: {
              sessionId: 'session-1',
              update: {
                sessionUpdate: 'turn_completed',
                promptId: 'old-prompt',
                stopReason: 'end_turn'
              }
            }
          }));
          respond({});
        } else if (message.method === '_x.ai/sessions/list') {
          respond({ result: { sessions: [{ sessionId: 'session-1', modelId: 'grok-4.6', activity: 'idle' }] } });
        } else if (message.method === 'session/prompt') {
          const meta = message.params._meta as { promptId: string };
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'x.ai/queue/changed',
            params: { sessionId: 'session-1', entries: [{ id: meta.promptId }] }
          }));
          // session/prompt stays open until the turn completes. The queue
          // notification is the non-blocking acceptance signal.
        } else if (message.method === '_x.ai/session/close') {
          respond({ result: { success: true, outcome: 'closed' } });
        }
      });
    });

    const server: GrokAppServerInfo = {
      pid: process.pid,
      port: address.port,
      url: `ws://127.0.0.1:${address.port}/ws`,
      secret
    };
    const client = new GrokAcpClient(server);
    await client.connectAndInitialize();
    expect(client.defaultModel).toBe('grok-4.6');

    await expect(client.createSession('/repo', 'grok-4.6')).resolves.toBe('session-1');
    await client.loadSession('session-1', '/repo');
    expect(client.getTurns()).toEqual([
      { role: 'human', text: 'hello' },
      { role: 'assistant', text: 'hi' }
    ]);
    expect(client.getTerminal('old-prompt')).toMatchObject({ stopReason: 'end_turn' });
    await client.startPrompt('session-1', 'next', 'new-prompt');
    await client.closeSession('session-1');
    await client.close();

    expect(calls.find((call) => call.method === 'authenticate')?.params).toMatchObject({
      methodId: 'cached_token'
    });
    expect(calls.find((call) => call.method === 'session/new')?.params).toMatchObject({
      cwd: '/repo',
      mcpServers: [],
      _meta: { yoloMode: true, modelId: 'grok-4.6' }
    });
    expect(calls.find((call) => call.method === 'session/prompt')?.params).toMatchObject({
      sessionId: 'session-1',
      _meta: { promptId: 'new-prompt' }
    });
  });
});
