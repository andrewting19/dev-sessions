import path from 'node:path';
import { AgentTurnStatus, SessionCli, SessionMode, SessionTurn, StoredSession, WaitResult } from '../types';

const DEFAULT_GATEWAY_BASE_URL = 'http://host.docker.internal:6767';

interface CreateSessionOptions {
  path?: string;
  description?: string;
  cli?: SessionCli;
  mode?: SessionMode;
  model?: string;
}

interface WaitOptions {
  timeoutSeconds?: number;
  intervalSeconds?: number;
}

interface GatewayClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

interface CreateGatewayResponse {
  sessionId: string;
  session?: StoredSession;
}

interface ListGatewayResponse {
  sessions: StoredSession[];
}

interface LastMessageGatewayResponse {
  blocks: string[];
}

interface StatusGatewayResponse {
  status: AgentTurnStatus;
}

interface WaitGatewayResponse {
  waitResult: WaitResult;
}

function isAgentTurnStatus(value: string): value is AgentTurnStatus {
  return value === 'idle' || value === 'working' || value === 'waiting_for_input';
}

export function resolveGatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawUrl = env.DEV_SESSIONS_GATEWAY_URL;
  if (typeof rawUrl === 'string' && rawUrl.trim().length > 0) {
    return rawUrl.trim();
  }

  return DEFAULT_GATEWAY_BASE_URL;
}

export class GatewaySessionManager {
  private readonly baseUrl: string;

  private readonly fetchFn: typeof fetch;

  constructor(options: GatewayClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? resolveGatewayBaseUrl()).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async createSession(options: CreateSessionOptions): Promise<StoredSession> {
    const payload: Record<string, unknown> = {
      path: path.resolve(options.path ?? process.cwd()),
      cli: options.cli ?? 'claude',
      mode: options.mode ?? 'yolo'
    };

    if (typeof options.description === 'string' && options.description.trim().length > 0) {
      payload.description = options.description;
    }

    const response = await this.request<CreateGatewayResponse>('/create', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (response.session) {
      return response.session;
    }

    const listResponse = await this.request<ListGatewayResponse>('/list');
    const resolved = listResponse.sessions.find((candidate) => candidate.championId === response.sessionId);
    if (resolved) {
      return resolved;
    }

    const timestamp = new Date().toISOString();
    return {
      championId: response.sessionId,
      internalId: response.sessionId,
      cli: (payload.cli as SessionCli) ?? 'claude',
      mode: (payload.mode as SessionMode) ?? 'yolo',
      path: String(payload.path),
      description: options.description,
      status: 'active',
      createdAt: timestamp,
      lastUsed: timestamp
    };
  }

  async sendMessage(championId: string, message: string): Promise<void> {
    await this.request('/send', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: championId,
        message
      })
    });
  }

  async killSession(championId: string): Promise<void> {
    await this.request('/kill', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: championId
      })
    });
  }

  async listSessions(): Promise<StoredSession[]> {
    const response = await this.request<ListGatewayResponse>('/list');
    return response.sessions;
  }

  async getLastAssistantTextBlocks(championId: string, count: number): Promise<string[]> {
    const safeCount = Math.max(1, count);
    const query = new URLSearchParams({
      id: championId,
      n: String(safeCount)
    });
    const response = await this.request<LastMessageGatewayResponse>(`/last-message?${query.toString()}`);
    return response.blocks;
  }

  async getSessionStatus(championId: string): Promise<AgentTurnStatus> {
    const query = new URLSearchParams({
      id: championId
    });
    const response = await this.request<StatusGatewayResponse>(`/status?${query.toString()}`);
    if (!isAgentTurnStatus(response.status)) {
      throw new Error(`Gateway returned invalid status: ${String(response.status)}`);
    }

    return response.status;
  }

  async getSessionLogs(championId: string): Promise<SessionTurn[]> {
    const query = new URLSearchParams({ id: championId });
    const response = await this.request<{ logs: string }>(`/logs?${query.toString()}`);
    const raw = response.logs ?? '';
    const turns: SessionTurn[] = [];
    const blocks = raw.split(/\n\n(?=\[(HUMAN|ASSISTANT)\]\n)/);
    for (const block of blocks) {
      const match = /^\[(HUMAN|ASSISTANT)\]\n([\s\S]*)$/.exec(block.trim());
      if (match) {
        turns.push({
          role: match[1] === 'HUMAN' ? 'human' : 'assistant',
          text: match[2]
        });
      }
    }
    return turns;
  }

  async inspectSession(championId: string): Promise<StoredSession> {
    const query = new URLSearchParams({ id: championId });
    const response = await this.request<{ session: StoredSession }>(`/inspect?${query.toString()}`);
    return response.session;
  }

  async waitForSession(championId: string, options: WaitOptions = {}): Promise<WaitResult> {
    const timeoutSeconds = Math.max(1, options.timeoutSeconds ?? 300);
    const query = new URLSearchParams({
      id: championId,
      timeout: String(timeoutSeconds)
    });

    if (typeof options.intervalSeconds === 'number' && Number.isFinite(options.intervalSeconds)) {
      query.set('interval', String(Math.max(1, options.intervalSeconds)));
    }

    const response = await this.request<WaitGatewayResponse>(`/wait?${query.toString()}`);
    return response.waitResult;
  }

  private async request<T>(
    requestPath: string,
    init: Omit<RequestInit, 'headers'> & { headers?: HeadersInit } = {}
  ): Promise<T> {
    const requestUrl = `${this.baseUrl}${requestPath}`;
    let response: Response;
    try {
      response = await this.fetchFn(requestUrl, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...init.headers
        }
      });
    } catch (error) {
      // Sandbox/Docker sessions use the local gateway HTTP bridge; unreachable gateway fetches fail as TypeError.
      if (error instanceof TypeError) {
        const hint = 'Is the gateway running? Start it with: dev-sessions gateway --port <port>';
        const detail = typeof error.message === 'string' && error.message.length > 0 ? ` (${error.message})` : '';
        throw new Error(`Gateway request failed for ${requestUrl}${detail}. ${hint}`);
      }

      throw error;
    }

    const rawBody = await response.text();
    let payload: Record<string, unknown> = {};
    if (rawBody.length > 0) {
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        const preview = rawBody.slice(0, 200);
        throw new Error(
          `Gateway returned non-JSON response (status=${response.status}, url=${requestUrl}): ${preview}`
        );
      }
    }

    if (!response.ok) {
      const errorMessage =
        typeof payload.error === 'string' && payload.error.length > 0
          ? payload.error
          : `Gateway request failed with status ${response.status}`;
      throw new Error(errorMessage);
    }

    return payload as T;
  }
}
