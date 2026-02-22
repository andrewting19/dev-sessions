import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { generateChampionId, toTmuxSessionName } from './champion-ids';
import { ClaudeTmuxBackend } from './backends/claude-tmux';
import { CodexAppServerBackend } from './backends/codex-appserver';
import { GatewaySessionManager, resolveGatewayBaseUrl } from './gateway/client';
import { SessionStore, createDefaultSessionStore } from './session-store';
import {
  countAssistantMessages,
  getAssistantTextBlocks,
  getClaudeTranscriptPath,
  hasAssistantResponseAfterLatestUser,
  inferTranscriptStatus,
  readClaudeTranscript
} from './transcript/claude-parser';
import { AgentTurnStatus, SessionCli, SessionMode, StoredSession, WaitResult } from './types';

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
  constructor(
    private readonly store: SessionStore,
    private readonly claudeBackend: ClaudeTmuxBackend,
    private readonly codexBackend: CodexAppServerBackend = new CodexAppServerBackend()
  ) {}

  async createSession(options: CreateSessionOptions): Promise<StoredSession> {
    const workspacePath = path.resolve(options.path ?? process.cwd());
    const cli = options.cli ?? 'claude';
    const championId = await this.findAvailableChampionId();
    const timestamp = new Date().toISOString();
    let session: StoredSession;

    if (cli === 'codex') {
      const model = options.model ?? 'gpt-5.3-codex';
      const codexSession = await this.codexBackend.createSession(championId, workspacePath, model);
      session = {
        championId,
        internalId: codexSession.threadId,
        cli: 'codex',
        mode: 'native',
        path: workspacePath,
        description: options.description,
        status: 'active',
        model: codexSession.model,
        lastAssistantMessages: [],
        createdAt: timestamp,
        lastUsed: timestamp
      };
    } else {
      const mode = options.mode ?? 'yolo';
      const tmuxSessionName = toTmuxSessionName(championId);
      const internalId = randomUUID();

      await this.claudeBackend.createSession(tmuxSessionName, workspacePath, mode, internalId);
      session = {
        championId,
        internalId,
        cli: 'claude',
        mode,
        path: workspacePath,
        description: options.description,
        status: 'active',
        createdAt: timestamp,
        lastUsed: timestamp
      };
    }

    await this.store.upsertSession(session);
    return session;
  }

  async sendMessage(championId: string, message: string): Promise<void> {
    const session = await this.requireSession(championId);

    if (session.cli === 'codex') {
      const sendResult = await this.codexBackend.sendMessage(session.championId, session.internalId, message, {
        workspacePath: session.path,
        model: session.model
      });
      const nextAssistantMessages =
        sendResult.assistantMessage.length > 0
          ? [...(session.lastAssistantMessages ?? []), sendResult.assistantMessage]
          : [...(session.lastAssistantMessages ?? [])];

      await this.store.updateSession(championId, {
        internalId: sendResult.threadId,
        lastUsed: new Date().toISOString(),
        status: 'active',
        lastTurnStatus: sendResult.status,
        lastTurnError: sendResult.errorMessage,
        lastAssistantMessages: nextAssistantMessages
      });

      if (sendResult.timedOut || sendResult.status === 'interrupted') {
        throw new Error(sendResult.errorMessage ?? `Codex turn timed out for ${championId}`);
      }

      if (sendResult.status === 'failed') {
        const messageText = sendResult.errorMessage
          ? `Codex turn failed: ${sendResult.errorMessage}`
          : 'Codex turn failed';
        throw new Error(messageText);
      }

      return;
    }

    const tmuxSessionName = toTmuxSessionName(session.championId);
    await this.claudeBackend.sendMessage(tmuxSessionName, message);

    await this.store.updateSession(championId, {
      lastUsed: new Date().toISOString(),
      status: 'active',
      lastTurnStatus: undefined,
      lastTurnError: undefined
    });
  }

  async killSession(championId: string): Promise<void> {
    const session = await this.requireSession(championId);

    if (session.cli === 'codex') {
      await this.codexBackend.killSession(session.championId, session.appServerPid);
    } else {
      const tmuxSessionName = toTmuxSessionName(session.championId);

      try {
        await this.claudeBackend.killSession(tmuxSessionName);
      } catch (error: unknown) {
        if (
          !(error instanceof Error) ||
          !/failed to connect server|no server running|can't find session/i.test(error.message)
        ) {
          throw error;
        }
      }
    }

    await this.store.deleteSession(championId);
  }

  async listSessions(): Promise<StoredSession[]> {
    const sessions = (await this.store.listSessions()).filter((session) => session.status === 'active');
    const livenessChecks = await Promise.all(
      sessions.map(async (session) => ({
        championId: session.championId,
        exists:
          session.cli === 'codex'
            ? await this.codexBackend.sessionExists(session.championId, session.appServerPid)
            : await this.claudeBackend.sessionExists(toTmuxSessionName(session.championId))
      }))
    );

    const deadSessionIds = livenessChecks
      .filter((check) => !check.exists)
      .map((check) => check.championId);

    if (deadSessionIds.length > 0) {
      await this.store.pruneSessions(deadSessionIds);
    }

    return (await this.store.listSessions()).filter((session) => session.status === 'active');
  }

  async getLastAssistantTextBlocks(championId: string, count: number): Promise<string[]> {
    const session = await this.requireSession(championId);

    if (session.cli === 'codex') {
      const safeCount = Math.max(1, count);
      const sessionMessages = session.lastAssistantMessages ?? [];
      if (sessionMessages.length > 0) {
        return sessionMessages.slice(-safeCount);
      }

      return this.codexBackend.getLastAssistantMessages(championId, safeCount);
    }

    const transcriptPath = getClaudeTranscriptPath(session.path, session.internalId);
    const transcriptEntries = await readClaudeTranscript(transcriptPath);
    const blocks = getAssistantTextBlocks(transcriptEntries);

    return blocks.slice(-Math.max(1, count));
  }

  async getSessionStatus(championId: string): Promise<AgentTurnStatus> {
    const session = await this.requireSession(championId);

    if (session.cli === 'codex') {
      if (session.lastTurnStatus === 'failed') {
        const suffix = session.lastTurnError ? `: ${session.lastTurnError}` : '';
        throw new Error(`Codex turn failed${suffix}`);
      }

      if (session.lastTurnStatus === 'interrupted') {
        return 'working';
      }

      return 'idle';
    }

    const transcriptPath = getClaudeTranscriptPath(session.path, session.internalId);
    const transcriptEntries = await readClaudeTranscript(transcriptPath);

    return inferTranscriptStatus(transcriptEntries);
  }

  async waitForSession(championId: string, options: WaitOptions = {}): Promise<WaitResult> {
    const session = await this.requireSession(championId);

    if (session.cli === 'codex') {
      const timeoutMs = Math.max(1, options.timeoutSeconds ?? 300) * 1000;

      if (session.lastTurnStatus === 'failed') {
        const message = session.lastTurnError
          ? `Codex turn failed: ${session.lastTurnError}`
          : 'Codex turn failed';
        throw new Error(message);
      }

      await this.store.updateSession(championId, {
        lastUsed: new Date().toISOString()
      });

      if (session.lastTurnStatus === 'interrupted') {
        return {
          completed: false,
          timedOut: true,
          elapsedMs: timeoutMs
        };
      }

      return {
        completed: true,
        timedOut: false,
        elapsedMs: 0
      };
    }

    const transcriptPath = getClaudeTranscriptPath(session.path, session.internalId);
    const timeoutMs = Math.max(1, options.timeoutSeconds ?? 300) * 1000;
    const intervalMs = Math.max(1, options.intervalSeconds ?? 2) * 1000;
    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    const latestSendMs = Date.parse(session.lastUsed);
    const initialEntries = await readClaudeTranscript(transcriptPath);
    const baselineAssistantCount = countAssistantMessages(initialEntries);

    let lastMtimeMs = -1;
    let shouldReadTranscript = false;
    let cachedEntries: Awaited<ReturnType<typeof readClaudeTranscript>> = initialEntries;

    while (Date.now() <= deadline) {
      try {
        const fileStat = await stat(transcriptPath);
        if (fileStat.mtimeMs !== lastMtimeMs) {
          lastMtimeMs = fileStat.mtimeMs;
          shouldReadTranscript = true;
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }

        shouldReadTranscript = true;
        cachedEntries = [];
      }

      if (shouldReadTranscript) {
        cachedEntries = await readClaudeTranscript(transcriptPath);
        shouldReadTranscript = false;
      }

      if (
        hasAssistantResponseAfterLatestUser(cachedEntries) &&
        (
          countAssistantMessages(cachedEntries) > baselineAssistantCount ||
          this.hasAssistantResponseAtOrAfter(cachedEntries, latestSendMs)
        )
      ) {
        await this.store.updateSession(championId, {
          lastUsed: new Date().toISOString()
        });

        return {
          completed: true,
          timedOut: false,
          elapsedMs: Date.now() - startTime
        };
      }

      await this.sleep(intervalMs);
    }

    return {
      completed: false,
      timedOut: true,
      elapsedMs: Date.now() - startTime
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
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = generateChampionId();

      if (await this.store.getSession(candidate)) {
        continue;
      }

      if (await this.claudeBackend.sessionExists(toTmuxSessionName(candidate))) {
        continue;
      }

      return candidate;
    }

    throw new Error('Unable to allocate a unique champion ID');
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private hasAssistantResponseAtOrAfter(
    entries: Awaited<ReturnType<typeof readClaudeTranscript>>,
    thresholdMs: number
  ): boolean {
    if (!Number.isFinite(thresholdMs)) {
      return false;
    }

    return entries.some((entry) => {
      if (entry.type?.toLowerCase() !== 'assistant') {
        return false;
      }

      const timestamp = entry.timestamp;
      if (typeof timestamp !== 'string') {
        return false;
      }

      const parsed = Date.parse(timestamp);
      return !Number.isNaN(parsed) && parsed >= thresholdMs;
    });
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

  return new SessionManager(createDefaultSessionStore(), new ClaudeTmuxBackend(), new CodexAppServerBackend());
}
