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
      codexActiveTurnId: undefined,
      lastTurnStatus: undefined,
      lastTurnError: undefined
    };
  }

  async send(session: StoredSession, message: string): Promise<Partial<StoredSession>> {
    const sendResult = await this.raw.sendMessage(session.championId, session.internalId, message, {
      workspacePath: session.path,
      model: session.model
    });
    const existingMessages = session.lastAssistantMessages ?? [];
    const completedEarly = typeof sendResult.assistantText === 'string';
    const earlyAssistantText = sendResult.assistantText;
    const update: Partial<StoredSession> = {
      internalId: sendResult.threadId,
      appServerPid: sendResult.appServerPid,
      appServerPort: sendResult.appServerPort,
      codexActiveTurnId: completedEarly ? undefined : sendResult.turnId
    };
    if (typeof earlyAssistantText === 'string') {
      update.lastAssistantMessages = [...existingMessages, earlyAssistantText];
      update.codexTurnInProgress = false;
    }
    return update;
  }

  onSendError(_session: StoredSession, error: Error): Partial<StoredSession> {
    return {
      codexTurnInProgress: false,
      codexActiveTurnId: undefined,
      lastTurnStatus: 'failed',
      lastTurnError: error.message,
      lastUsed: new Date().toISOString()
    };
  }

  async status(session: StoredSession): Promise<BackendStatusResult> {
    const liveStatus = await this.raw.getThreadRuntimeStatus(session.internalId);
    const hasPendingTurnId = typeof session.codexActiveTurnId === 'string' && session.codexActiveTurnId.length > 0;

    if (liveStatus === 'active') {
      return { status: 'working', storeUpdate: { codexTurnInProgress: true } };
    }

    if (liveStatus === 'idle' || liveStatus === 'notLoaded') {
      if (hasPendingTurnId) {
        // Codex 0.104.0 may report idle while the tracked turn is still executing tools.
        // Keep status conservative until an exact turn/completed notification clears the latch.
        return { status: 'working', storeUpdate: { codexTurnInProgress: true } };
      }
      return { status: 'idle', storeUpdate: { codexTurnInProgress: false } };
    }

    if (liveStatus === 'systemError') {
      return { errorToThrow: new Error('Codex app-server is in a system error state'), status: 'idle' };
    }

    return { errorToThrow: new Error('Could not reach Codex app-server'), status: 'idle' };
  }

  async wait(session: StoredSession, timeoutMs: number, _intervalMs: number): Promise<BackendWaitResult> {
    const baseStoreUpdate: Partial<StoredSession> = { lastUsed: new Date().toISOString() };
    const hasPendingTurnId = typeof session.codexActiveTurnId === 'string' && session.codexActiveTurnId.length > 0;

    if (!session.codexTurnInProgress && !hasPendingTurnId && session.lastTurnStatus === 'failed') {
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

    if (!session.codexTurnInProgress && !hasPendingTurnId) {
      let liveStatus: Awaited<ReturnType<typeof this.raw.getThreadRuntimeStatus>>;
      try {
        liveStatus = await this.raw.getThreadRuntimeStatus(session.internalId);
      } catch {
        liveStatus = 'unknown';
      }

      if (liveStatus !== 'active') {
        return {
          completed: true,
          timedOut: false,
          elapsedMs: 0,
          storeUpdate: baseStoreUpdate
        };
      }
    }

    let waitResult: Awaited<ReturnType<CodexAppServerBackend['waitForThread']>>;
    try {
      waitResult = await this.raw.waitForThread(
        session.championId,
        session.internalId,
        timeoutMs,
        hasPendingTurnId ? session.codexActiveTurnId : undefined
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        completed: false,
        timedOut: false,
        elapsedMs: 0,
        storeUpdate: {
          codexTurnInProgress: false,
          codexActiveTurnId: undefined,
          lastTurnStatus: 'failed',
          lastTurnError: err.message,
          lastUsed: new Date().toISOString()
        },
        errorToThrow: err
      };
    }

    const completionTime = new Date().toISOString();
    const turnStillInProgress = waitResult.timedOut;
    const existingMessages = session.lastAssistantMessages ?? [];
    const updatedMessages = waitResult.assistantText
      ? [...existingMessages, waitResult.assistantText]
      : existingMessages;
    const postWaitUpdate: Partial<StoredSession> = {
      lastUsed: completionTime,
      codexTurnInProgress: turnStillInProgress,
      codexActiveTurnId: turnStillInProgress ? session.codexActiveTurnId : undefined,
      codexLastCompletedAt: turnStillInProgress ? session.codexLastCompletedAt : completionTime,
      // Don't write lastTurnStatus/lastTurnError on timeout — server is source of truth.
      // Only update turn outcome when the server actually told us something.
      ...(waitResult.timedOut ? {} : { lastTurnStatus: waitResult.status, lastTurnError: waitResult.errorMessage }),
      lastAssistantMessages: updatedMessages
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
    const cacheMayBeStale = session.lastTurnStatus === 'completed';
    if (!cacheMayBeStale && sessionMessages.length > 0) {
      return sessionMessages.slice(-safeCount);
    }
    // Read from thread history when the cache may be stale (e.g. completed turns observed out-of-band)
    // or when the cache is empty (e.g. process restart).
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
