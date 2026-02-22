import { describe, expect, it, vi } from 'vitest';
import { GatewaySessionManager } from '../../src/gateway/client';
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
});
