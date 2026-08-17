import { SessionCli, SessionTurn, StoredSession } from '../types';
import { Backend, BackendCreateOptions, BackendCreateResult, BackendStatusResult, BackendWaitResult } from './backend';
import { GrokAppServerBackend } from './grok-appserver';

export class GrokBackend implements Backend {
  readonly cli: SessionCli = 'grok';
  readonly deadSessionPolicy = 'deactivate' as const;

  constructor(private readonly raw: GrokAppServerBackend) {}

  async isChampionIdTaken(_championId: string): Promise<boolean> {
    return false;
  }

  async create(options: BackendCreateOptions): Promise<BackendCreateResult> {
    const created = await this.raw.createSession(options.workspacePath, options.model);
    return {
      internalId: created.sessionId,
      mode: 'native',
      appServerPid: created.appServerPid,
      appServerPort: created.appServerPort,
      model: created.model,
      grokTurnInProgress: false,
      lastAssistantMessages: []
    };
  }

  preSendStoreFields(_session: StoredSession, sendTime: string): Partial<StoredSession> {
    return {
      lastUsed: sendTime,
      status: 'active',
      grokTurnInProgress: true,
      grokActivePromptId: undefined,
      lastTurnStatus: undefined,
      lastTurnError: undefined
    };
  }

  async send(session: StoredSession, message: string): Promise<Partial<StoredSession>> {
    const result = await this.raw.sendMessage(session.internalId, session.path, message);
    return {
      appServerPid: result.appServerPid,
      appServerPort: result.appServerPort,
      grokTurnInProgress: true,
      grokActivePromptId: result.promptId
    };
  }

  onSendError(_session: StoredSession, error: Error): Partial<StoredSession> {
    return {
      grokTurnInProgress: false,
      grokActivePromptId: undefined,
      lastTurnStatus: 'failed',
      lastTurnError: error.message,
      lastUsed: new Date().toISOString()
    };
  }

  async status(session: StoredSession): Promise<BackendStatusResult> {
    const activity = await this.raw.getSessionActivity(session.internalId);
    if (activity === 'working') {
      return { status: 'working', storeUpdate: { grokTurnInProgress: true } };
    }
    if (activity === 'needs_input') {
      return { status: 'waiting_for_input', storeUpdate: { grokTurnInProgress: true } };
    }
    if (activity === 'dead') {
      return {
        status: 'idle',
        errorToThrow: new Error(`Grok Build session ${session.championId} is in a dead state`)
      };
    }
    return {
      status: 'idle',
      storeUpdate: { grokTurnInProgress: false, grokActivePromptId: undefined }
    };
  }

  async wait(session: StoredSession, timeoutMs: number, intervalMs: number): Promise<BackendWaitResult> {
    if (!session.grokTurnInProgress && !session.grokActivePromptId) {
      const activity = await this.raw.getSessionActivity(session.internalId);
      if (activity !== 'working' && activity !== 'needs_input') {
        return {
          completed: true,
          timedOut: false,
          elapsedMs: 0,
          storeUpdate: { lastUsed: new Date().toISOString() }
        };
      }
    }

    try {
      const result = await this.raw.waitForSession(
        session.internalId,
        session.path,
        session.grokActivePromptId,
        timeoutMs,
        intervalMs
      );
      if (result.timedOut) {
        return { ...result, storeUpdate: {} };
      }

      const messages = await this.raw.getLastMessages(session.internalId, session.path, 50);
      return {
        ...result,
        storeUpdate: {
          grokTurnInProgress: false,
          grokActivePromptId: undefined,
          lastTurnStatus: 'completed',
          lastTurnError: undefined,
          lastAssistantMessages: messages,
          lastUsed: new Date().toISOString()
        }
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        completed: false,
        timedOut: false,
        elapsedMs: 0,
        storeUpdate: {
          grokTurnInProgress: false,
          grokActivePromptId: undefined,
          lastTurnStatus: 'failed',
          lastTurnError: err.message,
          lastUsed: new Date().toISOString()
        },
        errorToThrow: err
      };
    }
  }

  async exists(session: StoredSession): Promise<'alive' | 'dead' | 'unknown'> {
    try {
      return (await this.raw.sessionExists(session.internalId)) ? 'alive' : 'dead';
    } catch {
      return 'unknown';
    }
  }

  async getLastMessages(session: StoredSession, count: number): Promise<string[]> {
    return this.raw.getLastMessages(session.internalId, session.path, count);
  }

  async getLogs(session: StoredSession): Promise<SessionTurn[]> {
    return this.raw.getLogs(session.internalId, session.path);
  }

  async kill(session: StoredSession): Promise<void> {
    await this.raw.closeSession(session.internalId);
  }

  async afterKill(remainingActiveSessions: StoredSession[]): Promise<void> {
    if (!remainingActiveSessions.some((session) => session.cli === 'grok' && session.host === undefined)) {
      await this.raw.stopAppServer();
    }
  }
}
