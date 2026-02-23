import path from 'node:path';
import { generateChampionId } from './champion-ids';
import { Backend } from './backends/backend';
import { ClaudeBackend } from './backends/claude-backend';
import { ClaudeTmuxBackend } from './backends/claude-tmux';
import { CodexBackend } from './backends/codex-backend';
import { CodexAppServerBackend } from './backends/codex-appserver';
import { GatewaySessionManager, resolveGatewayBaseUrl } from './gateway/client';
import { SessionStore, createDefaultSessionStore } from './session-store';
import { AgentTurnStatus, SessionCli, SessionMode, SessionTurn, StoredSession, WaitResult } from './types';

export interface CreateSessionOptions {
  path?: string;
  description?: string;
  cli?: SessionCli;
  mode?: SessionMode;
  model?: string;
}

export interface WaitOptions {
  timeoutSeconds?: number;
  intervalSeconds?: number;
}

export class SessionManager {
  private readonly backends: Map<SessionCli, Backend>;

  constructor(
    private readonly store: SessionStore,
    claudeBackend: Backend,
    codexBackend: Backend
  ) {
    this.backends = new Map([
      ['claude', claudeBackend],
      ['codex', codexBackend]
    ]);
  }

  private getBackend(cli: SessionCli): Backend {
    const backend = this.backends.get(cli);
    if (!backend) {
      throw new Error(`No backend registered for cli: ${cli}`);
    }
    return backend;
  }

  async createSession(options: CreateSessionOptions): Promise<StoredSession> {
    const workspacePath = path.resolve(options.path ?? process.cwd());
    const cli = options.cli ?? 'claude';
    const backend = this.getBackend(cli);
    const championId = await this.findAvailableChampionId();
    const timestamp = new Date().toISOString();

    const result = await backend.create({
      championId,
      workspacePath,
      description: options.description,
      mode: options.mode,
      model: options.model
    });

    const session: StoredSession = {
      championId,
      internalId: result.internalId,
      cli,
      mode: result.mode,
      path: workspacePath,
      description: options.description,
      status: 'active',
      appServerPid: result.appServerPid,
      appServerPort: result.appServerPort,
      model: result.model,
      codexTurnInProgress: result.codexTurnInProgress,
      lastAssistantMessages: result.lastAssistantMessages,
      createdAt: timestamp,
      lastUsed: timestamp
    };

    await this.store.upsertSession(session);
    return session;
  }

  async sendMessage(championId: string, message: string): Promise<void> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    const sendTime = new Date().toISOString();

    const preSendFields = backend.preSendStoreFields(session, sendTime);
    if (Object.keys(preSendFields).length > 0) {
      await this.store.updateSession(championId, preSendFields);
    }

    let postSendFields: Partial<StoredSession>;
    try {
      postSendFields = await backend.send(session, message);
    } catch (error: unknown) {
      if (error instanceof Error) {
        const errorFields = backend.onSendError(session, error);
        if (Object.keys(errorFields).length > 0) {
          await this.store.updateSession(championId, errorFields);
        }
      }
      throw error;
    }

    if (Object.keys(postSendFields).length > 0) {
      await this.store.updateSession(championId, postSendFields);
    }
  }

  async killSession(championId: string): Promise<void> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);

    await backend.kill(session);
    await this.store.deleteSession(championId);

    const remainingActive = (await this.store.listSessions()).filter((s) => s.status === 'active');
    await backend.afterKill(remainingActive);
  }

  async listSessions(): Promise<StoredSession[]> {
    const sessions = (await this.store.listSessions()).filter((session) => session.status === 'active');
    const livenessChecks = await Promise.all(
      sessions.map(async (session) => {
        const backend = this.getBackend(session.cli);
        const liveness = await backend.exists(session);
        return { championId: session.championId, cli: session.cli, liveness };
      })
    );

    for (const check of livenessChecks) {
      if (check.liveness === 'unknown') {
        console.warn(`[dev-sessions] tmux returned an unexpected error for session ${check.championId}; keeping session record`);
      }
    }

    const deadSessions = sessions.filter((session) =>
      livenessChecks.some((check) => check.championId === session.championId && check.liveness === 'dead')
    );

    const deadDeactivateIds = deadSessions
      .filter((s) => this.getBackend(s.cli).deadSessionPolicy === 'deactivate')
      .map((s) => s.championId);

    const deadPruneIds = deadSessions
      .filter((s) => this.getBackend(s.cli).deadSessionPolicy === 'prune')
      .map((s) => s.championId);

    if (deadDeactivateIds.length > 0) {
      await Promise.all(
        deadDeactivateIds.map((id) =>
          this.store.updateSession(id, { status: 'inactive', codexTurnInProgress: false })
        )
      );
    }

    if (deadPruneIds.length > 0) {
      await this.store.pruneSessions(deadPruneIds);
    }

    return (await this.store.listSessions()).filter((session) => session.status === 'active');
  }

  async getLastAssistantTextBlocks(championId: string, count: number): Promise<string[]> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    return backend.getLastMessages(session, count);
  }

  async getSessionStatus(championId: string): Promise<AgentTurnStatus> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    const result = await backend.status(session);

    if (result.storeUpdate && Object.keys(result.storeUpdate).length > 0) {
      await this.store.updateSession(championId, result.storeUpdate);
    }

    if (result.errorToThrow) {
      throw result.errorToThrow;
    }

    return result.status;
  }

  async getSessionLogs(championId: string): Promise<SessionTurn[]> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    return backend.getLogs(session);
  }

  async inspectSession(championId: string): Promise<StoredSession> {
    return this.requireSession(championId);
  }

  async waitForSession(championId: string, options: WaitOptions = {}): Promise<WaitResult> {
    const session = await this.requireSession(championId);
    const backend = this.getBackend(session.cli);
    const timeoutMs = Math.max(0.05, options.timeoutSeconds ?? 300) * 1000;
    const intervalMs = Math.max(0.05, options.intervalSeconds ?? 2) * 1000;

    const result = await backend.wait(session, timeoutMs, intervalMs);

    if (Object.keys(result.storeUpdate).length > 0) {
      await this.store.updateSession(championId, result.storeUpdate);
    }

    if (result.errorToThrow) {
      throw result.errorToThrow;
    }

    return {
      completed: result.completed,
      timedOut: result.timedOut,
      elapsedMs: result.elapsedMs
    };
  }

  private async requireSession(championId: string): Promise<StoredSession> {
    const session = await this.store.getSession(championId);
    if (!session) {
      throw new Error(`Session not found: ${championId}`);
    }
    return session;
  }

  private async findAvailableChampionId(maxAttempts: number = 250): Promise<string> {
    const allBackends = [...this.backends.values()];

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = generateChampionId();

      if (await this.store.getSession(candidate)) {
        continue;
      }

      let taken = false;
      for (const b of allBackends) {
        if (await b.isChampionIdTaken(candidate)) {
          taken = true;
          break;
        }
      }

      if (taken) {
        continue;
      }

      return candidate;
    }

    throw new Error('Unable to allocate a unique champion ID');
  }
}

export function shouldUseGatewaySessionManager(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IS_SANDBOX === '1';
}

export function createDefaultSessionManager(
  env: NodeJS.ProcessEnv = process.env
): SessionManager | GatewaySessionManager {
  if (shouldUseGatewaySessionManager(env)) {
    return new GatewaySessionManager({
      baseUrl: resolveGatewayBaseUrl(env)
    });
  }

  return new SessionManager(
    createDefaultSessionStore(),
    new ClaudeBackend(new ClaudeTmuxBackend()),
    new CodexBackend(new CodexAppServerBackend())
  );
}
