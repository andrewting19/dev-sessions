import { describe, expect, it, vi } from 'vitest';
import { GatewaySessionManager, translateContainerPath } from '../../src/gateway/client';
import { StoredSession } from '../../src/types';

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  } as Response;
}

function createSessionFixture(championId: string): StoredSession {
  const now = '2026-02-22T00:00:00.000Z';
  return {
    championId,
    internalId: `uuid-${championId}`,
    cli: 'claude',
    mode: 'docker',
    path: '/host/project',
    description: 'gateway',
    status: 'active',
    createdAt: now,
    lastUsed: now
  };
}

describe('GatewaySessionManager', () => {
  it('creates sessions through the gateway API', async () => {
    const session = createSessionFixture('fizz-top');
    const fetchSpy = vi.fn(async () => jsonResponse(200, { sessionId: 'fizz-top', session }));
    const manager = new GatewaySessionManager({
      baseUrl: 'http://gateway.test:6767',
      fetchFn: fetchSpy as unknown as typeof fetch
    });

    const result = await manager.createSession({
      path: '/host/project',
      cli: 'claude',
      mode: 'docker',
      description: 'gateway'
    });

    expect(result).toEqual(session);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchSpy.mock.calls[0];
    expect(requestUrl).toBe('http://gateway.test:6767/create');
    expect((requestInit as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((requestInit as RequestInit).body))).toEqual({
      path: '/host/project',
      cli: 'claude',
      mode: 'docker',
      description: 'gateway'
    });
  });

  it('falls back to list lookup when create response omits session details', async () => {
    const session = createSessionFixture('riven-jg');
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { sessionId: 'riven-jg' }))
      .mockResolvedValueOnce(jsonResponse(200, { sessions: [session] }));
    const manager = new GatewaySessionManager({
      baseUrl: 'http://gateway.test:6767',
      fetchFn: fetchSpy as unknown as typeof fetch
    });

    const created = await manager.createSession({
      path: '/host/project',
      cli: 'claude',
      mode: 'docker'
    });

    expect(created).toEqual(session);
    const [requestUrl, requestInit] = fetchSpy.mock.calls[1];
    expect(requestUrl).toBe('http://gateway.test:6767/list');
    expect(requestInit).toEqual(
      expect.objectContaining({
        headers: {
          'content-type': 'application/json'
        }
      })
    );
  });

  it('passes timeout and interval to wait endpoint', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, { waitResult: { completed: true, timedOut: false, elapsedMs: 1500 } })
    );
    const manager = new GatewaySessionManager({
      baseUrl: 'http://gateway.test:6767',
      fetchFn: fetchSpy as unknown as typeof fetch
    });

    const result = await manager.waitForSession('fizz-top', {
      timeoutSeconds: 12,
      intervalSeconds: 3
    });

    expect(result).toEqual({
      completed: true,
      timedOut: false,
      elapsedMs: 1500
    });
    const [requestUrl] = fetchSpy.mock.calls[0];
    expect(requestUrl).toBe('http://gateway.test:6767/wait?id=fizz-top&timeout=12&interval=3');
  });

  it('throws gateway error payloads for non-2xx responses', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(404, { error: 'Session not found: fizz-top' }));
    const manager = new GatewaySessionManager({
      baseUrl: 'http://gateway.test:6767',
      fetchFn: fetchSpy as unknown as typeof fetch
    });

    await expect(manager.getSessionStatus('fizz-top')).rejects.toThrow('Session not found: fizz-top');
  });

  it('routes send/list/status/last-message/kill to the expected gateway endpoints', async () => {
    const fetchSpy = vi.fn(async (requestUrl: string) => {
      if (requestUrl.endsWith('/list')) {
        return jsonResponse(200, { sessions: [createSessionFixture('fizz-top')] });
      }

      if (requestUrl.includes('/status?')) {
        return jsonResponse(200, { status: 'working' });
      }

      if (requestUrl.includes('/last-message?')) {
        return jsonResponse(200, { blocks: ['block one', 'block two'] });
      }

      return jsonResponse(200, {});
    });
    const manager = new GatewaySessionManager({
      baseUrl: 'http://gateway.test:6767',
      fetchFn: fetchSpy as unknown as typeof fetch
    });

    await manager.sendMessage('fizz-top', 'hello');
    const sessions = await manager.listSessions();
    const status = await manager.getSessionStatus('fizz-top');
    const blocks = await manager.getLastAssistantTextBlocks('fizz-top', 2);
    await manager.killSession('fizz-top');

    expect(sessions).toHaveLength(1);
    expect(status).toBe('working');
    expect(blocks).toEqual(['block one', 'block two']);
    expect(fetchSpy.mock.calls).toHaveLength(5);

    expect(fetchSpy.mock.calls[0][0]).toBe('http://gateway.test:6767/send');
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toEqual({
      sessionId: 'fizz-top',
      message: 'hello'
    });

    expect(fetchSpy.mock.calls[1][0]).toBe('http://gateway.test:6767/list');
    expect(fetchSpy.mock.calls[2][0]).toBe('http://gateway.test:6767/status?id=fizz-top');
    expect(fetchSpy.mock.calls[3][0]).toBe('http://gateway.test:6767/last-message?id=fizz-top&n=2');
    expect(fetchSpy.mock.calls[4][0]).toBe('http://gateway.test:6767/kill');
  });

  it('translates container paths to host paths when IS_SANDBOX=1', () => {
    const env = {
      IS_SANDBOX: '1',
      HOST_PATH: '/Users/andrew/project'
    } as NodeJS.ProcessEnv;

    // /workspace → HOST_PATH
    expect(translateContainerPath('/workspace', env)).toBe('/Users/andrew/project');

    // /workspace/subdir → HOST_PATH/subdir
    expect(translateContainerPath('/workspace/src/index.ts', env)).toBe('/Users/andrew/project/src/index.ts');

    // Non-workspace path passes through
    expect(translateContainerPath('/tmp/other', env)).toBe('/tmp/other');

    // Without IS_SANDBOX, no translation
    expect(translateContainerPath('/workspace', { ...env, IS_SANDBOX: '0' })).toBe('/workspace');

    // Without HOST_PATH, no translation
    expect(translateContainerPath('/workspace', { IS_SANDBOX: '1' } as NodeJS.ProcessEnv)).toBe('/workspace');
  });

  it('translates paths with custom CONTAINER_WORKSPACE', () => {
    const env = {
      IS_SANDBOX: '1',
      HOST_PATH: '/Users/andrew/project',
      CONTAINER_WORKSPACE: '/app'
    } as NodeJS.ProcessEnv;

    expect(translateContainerPath('/app', env)).toBe('/Users/andrew/project');
    expect(translateContainerPath('/app/src', env)).toBe('/Users/andrew/project/src');
    expect(translateContainerPath('/workspace', env)).toBe('/workspace');
  });

  it('adds gateway URL and startup hint for fetch/network failures', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const manager = new GatewaySessionManager({
      baseUrl: 'http://127.0.0.1:6767',
      fetchFn: fetchSpy as unknown as typeof fetch
    });

    await expect(manager.listSessions()).rejects.toThrow(
      'Gateway request failed for http://127.0.0.1:6767/list'
    );
    await expect(manager.listSessions()).rejects.toThrow(
      'Is the gateway running? Start it with: dev-sessions gateway --port <port>'
    );
  });
});
