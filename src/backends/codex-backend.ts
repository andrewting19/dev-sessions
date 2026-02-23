import { SessionCli, SessionTurn, StoredSession } from '../types';
import { Backend, BackendCreateOptions, BackendCreateResult, BackendStatusResult, BackendWaitResult } from './backend';
import { CodexAppServerBackend } from './codex-appserver';

export class CodexBackend implements Backend {
  readonly cli: SessionCli = 'codex';
  readonly deadSessionPolicy = 'deactivate' as const;

  constructor(private readonly raw: CodexAppServerBackend) {}

  async isChampionIdTaken(_championId: string): Promise<boolean> {
    return false;
  }

  async create(options: BackendCreateOptions): Promise<BackendCreateResult> {
    const model = options.model ?? 'gpt-5.3-codex';
    const codexSession = await this.raw.createSession(options.championId, options.workspacePath, model);
    return {
      internalId: codexSession.threadId,
      mode: 'native',
      appServerPid: codexSession.appServerPid,
      appServerPort: codexSession.appServerPort,
      model: codexSession.model,
      codexTurnInProgress: false,
      lastAssistantMessages: []
    };
  }

  preSendStoreFields(_session: StoredSession, sendTime: string): Partial<StoredSession> {
    return {
      lastUsed: sendTime,
      status: 'active',
      codexTurnInProgress: true,
      lastTurnStatus: undefined,
      lastTurnError: undefined
    };
  }

  async send(session: StoredSession, message: string): Promise<Partial<StoredSession>> {
    const sendResult = await this.raw.sendMessage(session.championId, session.internalId, message, {
      workspacePath: session.path,
      model: session.model
    });
    return {
      internalId: sendResult.threadId,
      appServerPid: sendResult.appServerPid,
      appServerPort: sendResult.appServerPort
    };
  }

  onSendError(_session: StoredSession, error: Error): Partial<StoredSession> {
    return {
      codexTurnInProgress: false,
      lastTurnStatus: 'failed',
      lastTurnError: error.message,
      lastUsed: new Date().toISOString()
    };
  }

  async status(session: StoredSession): Promise<BackendStatusResult> {
    if (session.codexTurnInProgress) {
      return { status: 'working' };
    }

    if (session.lastTurnStatus === 'failed') {
      let liveStatus: Awaited<ReturnType<typeof this.raw.getThreadRuntimeStatus>>;
      try {
        liveStatus = await this.raw.getThreadRuntimeStatus(session.internalId);
      } catch {
        liveStatus = 'unknown';
      }

      if (liveStatus === 'active') {
        return { status: 'working' };
      }

      if (liveStatus === 'idle' || liveStatus === 'notLoaded') {
        return {
          status: 'idle',
          storeUpdate: { lastTurnStatus: 'completed', lastTurnError: undefined }
        };
      }

      const suffix = session.lastTurnError ? `: ${session.lastTurnError}` : '';
      return { status: 'idle', errorToThrow: new Error(`Codex turn failed${suffix}`) };
    }

    return { status: 'idle' };
  }

  async wait(session: StoredSession, timeoutMs: number, _intervalMs: number): Promise<BackendWaitResult> {
    const baseStoreUpdate: Partial<StoredSession> = { lastUsed: new Date().toISOString() };

    if (!session.codexTurnInProgress && session.lastTurnStatus === 'failed') {
      let liveStatus: Awaited<ReturnType<typeof this.raw.getThreadRuntimeStatus>>;
      try {
        liveStatus = await this.raw.getThreadRuntimeStatus(session.internalId);
      } catch {
        liveStatus = 'unknown';
      }

      if (liveStatus === 'idle' || liveStatus === 'notLoaded') {
        return {
          completed: true,
          timedOut: false,
          elapsedMs: 0,
          storeUpdate: { ...baseStoreUpdate, lastTurnStatus: 'completed', lastTurnError: undefined }
        };
      }

      if (liveStatus !== 'active') {
        const message = session.lastTurnError
          ? `Codex turn failed: ${session.lastTurnError}`
          : 'Codex turn failed';
        return {
          completed: false,
          timedOut: false,
          elapsedMs: 0,
          storeUpdate: {},
          errorToThrow: new Error(message)
        };
      }
      // Thread is active — fall through to waitForThread below
    }

    if (!session.codexTurnInProgress) {
      if (session.lastTurnStatus === 'interrupted') {
        return {
          completed: false,
          timedOut: true,
          elapsedMs: timeoutMs,
          storeUpdate: baseStoreUpdate
        };
      }

      return {
        completed: true,
        timedOut: false,
        elapsedMs: 0,
        storeUpdate: baseStoreUpdate
      };
    }

    let waitResult: Awaited<ReturnType<CodexAppServerBackend['waitForThread']>>;
    try {
      waitResult = await this.raw.waitForThread(session.championId, session.internalId, timeoutMs);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        completed: false,
        timedOut: false,
        elapsedMs: 0,
        storeUpdate: {
          codexTurnInProgress: false,
          lastTurnStatus: 'failed',
          lastTurnError: err.message,
          lastUsed: new Date().toISOString()
        },
        errorToThrow: err
      };
    }

    const completionTime = new Date().toISOString();
    const turnStillInProgress = waitResult.timedOut;
    const postWaitUpdate: Partial<StoredSession> = {
      lastUsed: completionTime,
      codexTurnInProgress: turnStillInProgress,
      codexLastCompletedAt: turnStillInProgress ? session.codexLastCompletedAt : completionTime,
      lastTurnStatus: waitResult.status,
      lastTurnError: waitResult.errorMessage
    };

    if (waitResult.status === 'failed') {
      const message = waitResult.errorMessage
        ? `Codex turn failed: ${waitResult.errorMessage}`
        : 'Codex turn failed';
      return {
        completed: false,
        timedOut: false,
        elapsedMs: waitResult.elapsedMs,
        storeUpdate: postWaitUpdate,
        errorToThrow: new Error(message)
      };
    }

    return {
      completed: !waitResult.timedOut && waitResult.status !== 'interrupted',
      timedOut: waitResult.timedOut || waitResult.status === 'interrupted',
      elapsedMs: waitResult.elapsedMs,
      storeUpdate: postWaitUpdate
    };
  }

  async exists(session: StoredSession): Promise<'alive' | 'dead' | 'unknown'> {
    try {
      const alive = await this.raw.sessionExists(
        session.championId,
        session.appServerPid,
        session.appServerPort,
        session.internalId
      );
      return alive ? 'alive' : 'dead';
    } catch {
      return 'unknown';
    }
  }

  async getLogs(session: StoredSession): Promise<SessionTurn[]> {
    return this.raw.getThreadTurns(session.internalId);
  }

  async getLastMessages(session: StoredSession, count: number): Promise<string[]> {
    const safeCount = Math.max(1, count);
    const sessionMessages = session.lastAssistantMessages ?? [];
    if (sessionMessages.length > 0) {
      return sessionMessages.slice(-safeCount);
    }
    return this.raw.getLastAssistantMessages(session.championId, session.internalId, safeCount);
  }

  async kill(session: StoredSession): Promise<void> {
    await this.raw.killSession(
      session.championId,
      session.appServerPid,
      session.internalId,
      session.appServerPort
    );
  }

  async afterKill(remainingActiveSessions: StoredSession[]): Promise<void> {
    const hasActiveCodexSessions = remainingActiveSessions.some((s) => s.cli === 'codex');
    if (!hasActiveCodexSessions) {
      await this.raw.stopAppServer();
    }
  }
}
