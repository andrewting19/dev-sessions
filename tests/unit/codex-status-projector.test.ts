import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodexProjectionNotification,
  CodexProjectionRpcClient,
  CodexProjectionWebSocketClient,
  CodexStatusProjector
} from '../../src/gateway/codex-status-projector';
import { SessionStore } from '../../src/session-store';
import { StoredSession } from '../../src/types';

type RuntimeStatus = 'active' | 'idle' | 'notLoaded' | 'systemError';

function createCodexSession(
  championId: string,
  overrides: Partial<StoredSession> = {}
): StoredSession {
  const now = '2026-08-11T12:00:00.000Z';
  return {
    championId,
    internalId: `thread-${championId}`,
    cli: 'codex',
    mode: 'native',
    path: '/tmp/project',
    status: 'active',
    appServerPid: 100,
    appServerPort: 5000,
    codexTurnInProgress: false,
    lastAssistantMessages: [],
    createdAt: now,
    lastUsed: now,
    ...overrides
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition');
}

class FakeProjectionClient implements CodexProjectionRpcClient {
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  connected = false;
  closed = false;
  private readonly closePromise: Promise<Error | undefined>;
  private resolveClose!: (error: Error | undefined) => void;

  constructor(
    private readonly onNotification: (notification: CodexProjectionNotification) => void,
    private readonly requestHandler: (method: string, params?: unknown) => unknown | Promise<unknown>,
    private readonly connectError?: Error
  ) {
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
  }

  async connectAndInitialize(): Promise<void> {
    if (this.connectError) {
      throw this.connectError;
    }
    this.connected = true;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.requestHandler(method, params);
  }

  waitForClose(): Promise<Error | undefined> {
    return this.closePromise;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolveClose(undefined);
  }

  emit(notification: CodexProjectionNotification): void {
    this.onNotification(notification);
  }

  disconnect(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolveClose(error);
  }
}

describe('CodexStatusProjector', () => {
  let tmpDir = '';
  let store: SessionStore;
  let projector: CodexStatusProjector | undefined;
  let currentServer = { pid: 100, port: 5000, url: 'ws://127.0.0.1:5000' };
  let statuses: Record<string, RuntimeStatus>;
  let loadedThreadIds: string[];
  let clients: FakeProjectionClient[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-projector-'));
    store = new SessionStore(path.join(tmpDir, 'sessions.json'));
    currentServer = { pid: 100, port: 5000, url: 'ws://127.0.0.1:5000' };
    statuses = {};
    loadedThreadIds = [];
    clients = [];
  });

  afterEach(async () => {
    await projector?.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function startProjector(): CodexStatusProjector {
    projector = new CodexStatusProjector({
      store,
      daemonManager: {
        getServer: async () => currentServer
      },
      clientFactory: (_url, onNotification) => {
        const client = new FakeProjectionClient(onNotification, async (method, params) => {
          if (method === 'thread/loaded/list') {
            return { data: loadedThreadIds };
          }
          if (method === 'thread/read') {
            const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
            if (typeof threadId !== 'string') {
              throw new Error('thread/read missing threadId');
            }
            return {
              thread: {
                id: threadId,
                status: { type: statuses[threadId] ?? 'notLoaded' }
              }
            };
          }
          throw new Error(`unexpected request: ${method}`);
        });
        clients.push(client);
        return client;
      },
      reconnectDelayMs: 5,
      serverCheckIntervalMs: 10,
      logger: {
        info: () => {},
        warn: () => {}
      },
      now: () => new Date('2026-08-11T18:00:00.000Z')
    });
    projector.start();
    return projector;
  }

  async function waitForReconcile(clientIndex: number = 0): Promise<FakeProjectionClient> {
    await waitFor(() => clients.length > clientIndex && Boolean(projector?.getStatus().lastReconciledAt));
    return clients[clientIndex];
  }

  it('repairs a stale active-turn latch at startup without resuming the thread', async () => {
    await store.upsertSession(createCodexSession('evelynn-mid', {
      codexTurnInProgress: true,
      codexActiveTurnId: 'turn-old'
    }));
    statuses['thread-evelynn-mid'] = 'notLoaded';

    startProjector();
    const client = await waitForReconcile();

    const session = await store.getSession('evelynn-mid');
    expect(session?.codexTurnInProgress).toBe(false);
    expect(session?.codexActiveTurnId).toBeUndefined();
    expect(client.requests).toContainEqual({
      method: 'thread/read',
      params: {
        threadId: 'thread-evelynn-mid',
        includeTurns: false
      }
    });
    expect(client.requests.some((request) => request.method === 'thread/resume')).toBe(false);
  });

  it('finds an active loaded thread when the stored projection is idle', async () => {
    await store.upsertSession(createCodexSession('soraka-adc', {
      lastTurnStatus: 'failed',
      lastTurnError: 'old failure'
    }));
    loadedThreadIds = ['thread-soraka-adc'];
    statuses['thread-soraka-adc'] = 'active';

    startProjector();
    await waitForReconcile();

    const session = await store.getSession('soraka-adc');
    expect(session?.codexTurnInProgress).toBe(true);
    expect(session?.lastTurnStatus).toBeUndefined();
    expect(session?.lastTurnError).toBeUndefined();
  });

  it('clears a system-error latch without replacing an exact stored error', async () => {
    await store.upsertSession(createCodexSession('system-error', {
      codexTurnInProgress: true,
      codexActiveTurnId: 'turn-failed',
      lastTurnStatus: 'failed',
      lastTurnError: 'exact model failure'
    }));
    statuses['thread-system-error'] = 'systemError';

    startProjector();
    await waitForReconcile();

    const session = await store.getSession('system-error');
    expect(session?.codexTurnInProgress).toBe(false);
    expect(session?.codexActiveTurnId).toBeUndefined();
    expect(session?.lastTurnStatus).toBe('failed');
    expect(session?.lastTurnError).toBe('exact model failure');
  });

  it('projects active and idle status notifications with a confirming read', async () => {
    await store.upsertSession(createCodexSession('rumble-top'));
    startProjector();
    const client = await waitForReconcile();

    statuses['thread-rumble-top'] = 'active';
    client.emit({
      method: 'thread/status/changed',
      params: { threadId: 'thread-rumble-top', status: { type: 'active', activeFlags: [] } }
    });
    await waitFor(async () => (await store.getSession('rumble-top'))?.codexTurnInProgress === true);

    statuses['thread-rumble-top'] = 'idle';
    client.emit({
      method: 'thread/status/changed',
      params: { threadId: 'thread-rumble-top', status: { type: 'idle' } }
    });
    await waitFor(async () => (await store.getSession('rumble-top'))?.codexTurnInProgress === false);

    expect(client.requests.filter((request) => request.method === 'thread/read')).toHaveLength(1);
  });

  it('does not let an old completion clear a newer active turn', async () => {
    await store.upsertSession(createCodexSession('corki-jg'));
    startProjector();
    const client = await waitForReconcile();

    client.emit({
      method: 'turn/started',
      params: { threadId: 'thread-corki-jg', turn: { id: 'turn-new', status: 'inProgress' } }
    });
    await waitFor(async () => (await store.getSession('corki-jg'))?.codexActiveTurnId === 'turn-new');

    client.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-corki-jg', turn: { id: 'turn-old', status: 'completed' } }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.getSession('corki-jg'))?.codexActiveTurnId).toBe('turn-new');

    client.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-corki-jg', turn: { id: 'turn-new', status: 'completed' } }
    });
    await waitFor(async () => (await store.getSession('corki-jg'))?.codexTurnInProgress === false);

    const completed = await store.getSession('corki-jg');
    expect(completed?.codexActiveTurnId).toBeUndefined();
    expect(completed?.lastTurnStatus).toBe('completed');
    expect(completed?.codexLastCompletedAt).toBe('2026-08-11T18:00:00.000Z');

    client.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-corki-jg', turn: { id: 'turn-new', status: 'completed' } }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.getSession('corki-jg'))?.lastTurnStatus).toBe('completed');
  });

  it('keeps simultaneous threads separate when completions arrive in reverse order', async () => {
    await store.upsertSession(createCodexSession('thread-a'));
    await store.upsertSession(createCodexSession('thread-b'));
    startProjector();
    const client = await waitForReconcile();

    client.emit({
      method: 'turn/started',
      params: { threadId: 'thread-thread-a', turn: { id: 'turn-a', status: 'inProgress' } }
    });
    client.emit({
      method: 'turn/started',
      params: { threadId: 'thread-thread-b', turn: { id: 'turn-b', status: 'inProgress' } }
    });
    await waitFor(async () => (
      (await store.getSession('thread-a'))?.codexActiveTurnId === 'turn-a' &&
      (await store.getSession('thread-b'))?.codexActiveTurnId === 'turn-b'
    ));

    client.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-thread-b', turn: { id: 'turn-b', status: 'completed' } }
    });

    await waitFor(async () => (await store.getSession('thread-b'))?.lastTurnStatus === 'completed');
    expect((await store.getSession('thread-a'))?.codexActiveTurnId).toBe('turn-a');

    client.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-thread-a', turn: { id: 'turn-a', status: 'completed' } }
    });
    await waitFor(async () => (await store.getSession('thread-a'))?.codexTurnInProgress === false);
  });

  it('reconnects after an app-server PID change and reconciles missed completion', async () => {
    await store.upsertSession(createCodexSession('velkoz-adc', {
      codexTurnInProgress: true,
      codexActiveTurnId: 'turn-running'
    }));
    statuses['thread-velkoz-adc'] = 'active';

    startProjector();
    await waitForReconcile();
    expect((await store.getSession('velkoz-adc'))?.codexTurnInProgress).toBe(true);

    statuses['thread-velkoz-adc'] = 'idle';
    currentServer = { pid: 200, port: 5001, url: 'ws://127.0.0.1:5001' };

    await waitFor(() => clients.length >= 2, 2_000);
    await waitFor(async () => (await store.getSession('velkoz-adc'))?.codexTurnInProgress === false, 2_000);
    expect(clients[0].closed).toBe(true);
    expect(clients[1].connected).toBe(true);
    expect((await store.getSession('velkoz-adc'))?.codexActiveTurnId).toBeUndefined();
  });

  it('does not read or resume idle stored threads and ignores remote cache records', async () => {
    for (let index = 0; index < 100; index += 1) {
      await store.upsertSession(createCodexSession(`local-${index}`));
    }
    await store.upsertSession(createCodexSession('remote-one', {
      host: 'mi-box',
      codexTurnInProgress: true,
      codexActiveTurnId: 'remote-turn'
    }));

    startProjector();
    const client = await waitForReconcile();

    expect(client.requests).toEqual([{ method: 'thread/loaded/list', params: {} }]);
    expect((await store.getSession('remote-one'))?.codexTurnInProgress).toBe(true);
  });
});

describe('CodexProjectionWebSocketClient', () => {
  let server: WebSocketServer | undefined;
  let client: CodexProjectionWebSocketClient | undefined;

  afterEach(async () => {
    await client?.close();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('initializes with high-volume notification opt-outs and forwards status events', async () => {
    const initializeRequests: Array<Record<string, unknown>> = [];
    const notifications: CodexProjectionNotification[] = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server?.once('listening', resolve));

    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        for (const line of data.toString().split('\n')) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.method === 'initialize' && typeof message.id === 'number') {
            initializeRequests.push(message);
            socket.send(`${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { userAgent: 'Codex Desktop/0.144.3 test' }
            })}\n`);
          }
          if (message.method === 'initialized') {
            socket.send(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'thread/status/changed',
              params: { threadId: 'thread-one', status: { type: 'active', activeFlags: [] } }
            })}\n`);
          }
        }
      });
    });

    const address = server.address() as AddressInfo;
    client = new CodexProjectionWebSocketClient(
      `ws://127.0.0.1:${address.port}`,
      (notification) => notifications.push(notification),
      1_000,
      100
    );
    await client.connectAndInitialize();
    await waitFor(() => notifications.length === 1);

    const params = initializeRequests[0].params as {
      capabilities?: { optOutNotificationMethods?: unknown };
    };
    expect(params.capabilities?.optOutNotificationMethods).toEqual(
      expect.arrayContaining([
        'item/agentMessage/delta',
        'item/commandExecution/outputDelta',
        'thread/tokenUsage/updated'
      ])
    );
    expect(client.serverUserAgent).toBe('Codex Desktop/0.144.3 test');
    expect(notifications).toEqual([{
      method: 'thread/status/changed',
      params: { threadId: 'thread-one', status: { type: 'active', activeFlags: [] } }
    }]);
  });
});
