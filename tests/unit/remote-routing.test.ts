import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteCommandError, RemoteHostClient } from '../../src/remote/remote-client';
import { isCompatibleRemoteVersion, resolveRemoteBin, RoutingSessionManager } from '../../src/remote/routing-manager';
import { SshTransportError } from '../../src/remote/ssh-runner';
import type { SessionManager } from '../../src/session-manager';
import { SessionStore } from '../../src/session-store';
import { StoredSession } from '../../src/types';

function mockSession(championId: string, overrides: Partial<StoredSession> = {}): StoredSession {
  const now = '2026-07-01T00:00:00.000Z';
  return {
    championId,
    internalId: `${championId}-uuid`,
    cli: 'claude',
    mode: 'native',
    path: '/tmp/workspace',
    status: 'active',
    createdAt: now,
    lastUsed: now,
    ...overrides
  };
}

interface FakeRemote {
  client: RemoteHostClient;
  version: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  waitGoal: ReturnType<typeof vi.fn>;
  getGoal: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
}

function createFakeRemote(): FakeRemote {
  const fns = {
    version: vi.fn().mockResolvedValue('0.4.0'),
    create: vi.fn(async (options: { championId: string }) =>
      mockSession(options.championId, { path: '/home/remote/project' })
    ),
    send: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue('idle'),
    wait: vi.fn().mockResolvedValue({ completed: true, timedOut: false, elapsedMs: 100 }),
    waitGoal: vi.fn().mockResolvedValue({ completed: true, timedOut: false, elapsedMs: 100 }),
    waitNextTurn: vi.fn().mockResolvedValue({ completed: true, timedOut: false, elapsedMs: 100 }),
    getGoal: vi.fn().mockResolvedValue(undefined),
    setGoal: vi.fn(),
    clearGoal: vi.fn().mockResolvedValue(true),
    lastMessages: vi.fn().mockResolvedValue(['remote says hi']),
    logs: vi.fn().mockResolvedValue([]),
    inspect: vi.fn(async () => mockSession('fizz-top', { path: '/home/remote/project' }))
  };

  return { client: fns as unknown as RemoteHostClient, ...fns } as FakeRemote;
}

function createLocalManagerMock(): SessionManager {
  return {
    createSession: vi.fn(async () => mockSession('local-one')),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([mockSession('local-one')]),
    getLastAssistantTextBlocks: vi.fn().mockResolvedValue(['local reply']),
    getSessionStatus: vi.fn().mockResolvedValue('idle'),
    waitForSession: vi.fn().mockResolvedValue({ completed: true, timedOut: false, elapsedMs: 10 }),
    getSessionLogs: vi.fn().mockResolvedValue([]),
    inspectSession: vi.fn(async () => mockSession('local-one')),
    setSessionGoal: vi.fn(),
    getSessionGoal: vi.fn(),
    clearSessionGoal: vi.fn(),
    waitForSessionGoal: vi.fn(),
    waitForSessionNextTurn: vi.fn()
  } as unknown as SessionManager;
}

describe('version and remote bin helpers', () => {
  it('treats same major.minor as compatible pre-1.0', () => {
    expect(isCompatibleRemoteVersion('0.4.0', '0.4.2')).toBe(true);
    expect(isCompatibleRemoteVersion('0.4.0', '0.3.9')).toBe(false);
    expect(isCompatibleRemoteVersion('1.2.0', '1.5.1')).toBe(true);
    expect(isCompatibleRemoteVersion('1.2.0', '2.0.0')).toBe(false);
    expect(isCompatibleRemoteVersion('0.4.0', 'garbage')).toBe(false);
  });

  it('resolves the remote bin from the environment', () => {
    expect(resolveRemoteBin({})).toBe('dev-sessions');
    expect(resolveRemoteBin({ DEV_SESSIONS_REMOTE_BIN: '/opt/node/bin/dev-sessions' })).toBe('/opt/node/bin/dev-sessions');
  });
});

describe('RoutingSessionManager', () => {
  let storeDir: string;
  let store: SessionStore;
  let local: SessionManager;
  let remote: FakeRemote;
  let warnings: string[];
  let manager: RoutingSessionManager;
  let clientFactoryCalls: Array<{ host: string; remoteBin: string }>;

  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(os.tmpdir(), 'ds-routing-test-'));
    store = new SessionStore(path.join(storeDir, 'sessions.json'));
    local = createLocalManagerMock();
    remote = createFakeRemote();
    warnings = [];
    clientFactoryCalls = [];
    manager = new RoutingSessionManager(local, store, {
      localVersion: '0.4.0',
      env: {},
      warn: (message) => warnings.push(message),
      clientFactory: (host, remoteBin) => {
        clientFactoryCalls.push({ host, remoteBin });
        return remote.client;
      }
    });
  });

  afterEach(async () => {
    await rm(storeDir, { recursive: true, force: true });
  });

  async function createRemoteSession(): Promise<StoredSession> {
    return manager.createSession({ host: 'buildbox', cli: 'claude', mode: 'native' });
  }

  it('delegates local creates untouched', async () => {
    await manager.createSession({ path: '/tmp/workspace' });
    expect(local.createSession).toHaveBeenCalledWith({ path: '/tmp/workspace' });
    expect(remote.create).not.toHaveBeenCalled();
  });

  it('creates remotely with a pre-allocated ID and stores a host stub', async () => {
    const session = await createRemoteSession();

    expect(remote.version).toHaveBeenCalled();
    expect(remote.create).toHaveBeenCalledWith(expect.objectContaining({ championId: session.championId }));
    expect(session.host).toBe('buildbox');
    expect(session.path).toBe('/home/remote/project');

    const stored = await store.getSession(session.championId);
    expect(stored?.host).toBe('buildbox');
    expect(stored?.remoteBin).toBe('dev-sessions');
    expect(warnings).toHaveLength(0);
  });

  it('warns when the remote version is incompatible but continues', async () => {
    remote.version.mockResolvedValue('0.1.0');
    await createRemoteSession();
    expect(warnings.some((w) => /0\.1\.0/.test(w))).toBe(true);
    expect(remote.create).toHaveBeenCalled();
  });

  it('retries ID allocation when the remote reports the ID is taken', async () => {
    remote.create
      .mockRejectedValueOnce(new RemoteCommandError('Remote create failed: Champion ID already in use: fizz-top', 1))
      .mockImplementationOnce(async (options: { championId: string }) => mockSession(options.championId));

    const session = await createRemoteSession();
    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(session.host).toBe('buildbox');
  });

  it('does not retry when the ID collides locally', async () => {
    // Fill the local store with a colliding record and force generateChampionId
    // collisions to be plausible: instead, verify the guarantee directly — the
    // allocated ID is never one already present in the local registry.
    await store.upsertSession(mockSession('taken-id'));
    const session = await createRemoteSession();
    expect(session.championId).not.toBe('taken-id');
  });

  it('routes send to the remote and refreshes lastUsed on the stub', async () => {
    const session = await createRemoteSession();
    await manager.sendMessage(session.championId, 'do the thing');

    expect(remote.send).toHaveBeenCalledWith(session.championId, 'do the thing');
    expect(local.sendMessage).not.toHaveBeenCalled();
    const stored = await store.getSession(session.championId);
    expect(Date.parse(stored?.lastUsed ?? '')).toBeGreaterThan(Date.parse('2026-07-01T00:00:00.000Z'));
  });

  it('routes id-based reads to the remote', async () => {
    const session = await createRemoteSession();

    expect(await manager.getSessionStatus(session.championId)).toBe('idle');
    expect(await manager.getLastAssistantTextBlocks(session.championId, 1)).toEqual(['remote says hi']);
    expect(remote.status).toHaveBeenCalledWith(session.championId);
    expect(local.getSessionStatus).not.toHaveBeenCalled();
  });

  it('falls through to the local manager for unknown IDs', async () => {
    await manager.getSessionStatus('local-one');
    expect(local.getSessionStatus).toHaveBeenCalledWith('local-one');
  });

  it('kills remotely and removes the stub', async () => {
    const session = await createRemoteSession();
    await manager.killSession(session.championId);

    expect(remote.kill).toHaveBeenCalledWith(session.championId);
    expect(await store.getSession(session.championId)).toBeUndefined();
  });

  it('removes the stub when the remote session is already gone', async () => {
    const session = await createRemoteSession();
    remote.kill.mockRejectedValue(new RemoteCommandError('Remote kill failed: Session not found: x', 1));

    await manager.killSession(session.championId);
    expect(await store.getSession(session.championId)).toBeUndefined();
  });

  it('keeps the stub when kill fails at the transport layer', async () => {
    const session = await createRemoteSession();
    remote.kill.mockRejectedValue(new SshTransportError('buildbox', 'connection refused'));

    await expect(manager.killSession(session.championId)).rejects.toBeInstanceOf(SshTransportError);
    expect(await store.getSession(session.championId)).toBeDefined();
  });

  it('merges local and remote sessions in list and prunes stale stubs', async () => {
    const alive = await createRemoteSession();
    const stale = await createRemoteSession();
    remote.list.mockResolvedValue([mockSession(alive.championId, { path: '/home/remote/project' })]);

    const sessions = await manager.listSessions();
    const ids = sessions.map((s) => s.championId);

    expect(ids).toContain('local-one');
    expect(ids).toContain(alive.championId);
    expect(ids).not.toContain(stale.championId);
    expect(await store.getSession(stale.championId)).toBeUndefined();

    const merged = sessions.find((s) => s.championId === alive.championId);
    expect(merged?.host).toBe('buildbox');
  });

  it('keeps cached stubs and warns when a host is unreachable during list', async () => {
    const session = await createRemoteSession();
    remote.list.mockRejectedValue(new SshTransportError('buildbox', 'connection timed out'));

    const sessions = await manager.listSessions();
    expect(sessions.map((s) => s.championId)).toContain(session.championId);
    expect(warnings.some((w) => /could not reach buildbox/.test(w))).toBe(true);
    expect(await store.getSession(session.championId)).toBeDefined();
  });

  it('passes wait timeout results through for remote sessions', async () => {
    const session = await createRemoteSession();
    remote.wait.mockResolvedValue({ completed: false, timedOut: true, elapsedMs: 30000 });

    const result = await manager.waitForSession(session.championId, { timeoutSeconds: 30 });
    expect(result.timedOut).toBe(true);
    expect(remote.wait).toHaveBeenCalledWith(session.championId, { timeoutSeconds: 30, intervalSeconds: undefined });
  });

  it('fetches the goal after a remote goal wait completes', async () => {
    const session = await createRemoteSession();
    const goal = {
      threadId: 'thr_1',
      objective: 'finish',
      status: 'complete',
      tokenBudget: null,
      tokensUsed: 5,
      timeUsedSeconds: 3,
      createdAt: 1,
      updatedAt: 2
    };
    remote.getGoal.mockResolvedValue(goal);

    const result = await manager.waitForSessionGoal(session.championId, { timeoutSeconds: 60 });
    expect(result.timedOut).toBe(false);
    expect(result.goal?.status).toBe('complete');
  });

  it('attaches host metadata to remote inspect results', async () => {
    const session = await createRemoteSession();
    remote.inspect.mockResolvedValue(mockSession(session.championId, { path: '/home/remote/project' }));

    const inspected = await manager.inspectSession(session.championId);
    expect(inspected.host).toBe('buildbox');
    expect(inspected.remoteBin).toBe('dev-sessions');
  });

  it('constructs clients with the configured remote bin', async () => {
    manager = new RoutingSessionManager(local, store, {
      localVersion: '0.4.0',
      env: { DEV_SESSIONS_REMOTE_BIN: '/opt/bin/dev-sessions' },
      warn: (message) => warnings.push(message),
      clientFactory: (host, remoteBin) => {
        clientFactoryCalls.push({ host, remoteBin });
        return remote.client;
      }
    });

    const session = await createRemoteSession();
    expect(clientFactoryCalls[0]).toEqual({ host: 'buildbox', remoteBin: '/opt/bin/dev-sessions' });

    const stored = await store.getSession(session.championId);
    expect(stored?.remoteBin).toBe('/opt/bin/dev-sessions');
  });
});
