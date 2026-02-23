import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { toTmuxSessionName } from '../champion-ids';
import {
  countAssistantMessages,
  countFileHistorySnapshots,
  countSystemEntries,
  extractTextBlocks,
  getAssistantTextBlocks,
  getClaudeTranscriptPath,
  inferTranscriptStatus,
  readClaudeTranscript
} from '../transcript/claude-parser';
import { AgentTurnStatus, SessionCli, SessionTurn, StoredSession } from '../types';
import { Backend, BackendCreateOptions, BackendCreateResult, BackendStatusResult, BackendWaitResult } from './backend';
import { ClaudeTmuxBackend } from './claude-tmux';

export class ClaudeBackend implements Backend {
  readonly cli: SessionCli = 'claude';
  readonly deadSessionPolicy = 'prune' as const;

  constructor(private readonly raw: ClaudeTmuxBackend) {}

  async isChampionIdTaken(championId: string): Promise<boolean> {
    return (await this.raw.sessionExists(toTmuxSessionName(championId))) === 'alive';
  }

  async create(options: BackendCreateOptions): Promise<BackendCreateResult> {
    const mode = options.mode ?? 'native';
    const internalId = randomUUID();
    const tmuxSessionName = toTmuxSessionName(options.championId);
    await this.raw.createSession(tmuxSessionName, options.workspacePath, mode, internalId);
    return { internalId, mode };
  }

  preSendStoreFields(_session: StoredSession, _sendTime: string): Partial<StoredSession> {
    return {};
  }

  async send(session: StoredSession, message: string): Promise<Partial<StoredSession>> {
    const tmuxSessionName = toTmuxSessionName(session.championId);
    const sendTime = new Date().toISOString();
    await this.raw.sendMessage(tmuxSessionName, message);
    return {
      lastUsed: sendTime,
      status: 'active',
      lastTurnStatus: undefined,
      lastTurnError: undefined
    };
  }

  onSendError(_session: StoredSession, _error: Error): Partial<StoredSession> {
    return {};
  }

  async status(session: StoredSession): Promise<BackendStatusResult> {
    const transcriptPath = getClaudeTranscriptPath(session.path, session.internalId);
    const transcriptEntries = await readClaudeTranscript(transcriptPath);
    const status: AgentTurnStatus = inferTranscriptStatus(transcriptEntries);
    return { status };
  }

  async wait(session: StoredSession, timeoutMs: number, intervalMs: number): Promise<BackendWaitResult> {
    const transcriptPath = getClaudeTranscriptPath(session.path, session.internalId);
    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    const initialEntries = await readClaudeTranscript(transcriptPath);
    const baselineAssistantCount = countAssistantMessages(initialEntries);
    const baselineSystemCount = countSystemEntries(initialEntries);
    const baselineFileHistoryCount = countFileHistorySnapshots(initialEntries);

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

      const hasNewAssistant = countAssistantMessages(cachedEntries) > baselineAssistantCount;
      const hasNewSystemEntry = countSystemEntries(cachedEntries) > baselineSystemCount;
      const hasNewFileHistorySnapshot = countFileHistorySnapshots(cachedEntries) > baselineFileHistoryCount;

      // A system entry followed by a new assistant message is the primary completion signal.
      if (hasNewSystemEntry && hasNewAssistant) {
        return {
          completed: true,
          timedOut: false,
          elapsedMs: Date.now() - startTime,
          storeUpdate: { lastUsed: new Date().toISOString() }
        };
      }

      // For turns that end without a system entry (e.g. long tool runs), Claude writes a
      // file-history-snapshot at turn completion. Use that as the fallback signal.
      if (hasNewFileHistorySnapshot && hasNewAssistant) {
        return {
          completed: true,
          timedOut: false,
          elapsedMs: Date.now() - startTime,
          storeUpdate: { lastUsed: new Date().toISOString() }
        };
      }

      await this.sleep(intervalMs);
    }

    return {
      completed: false,
      timedOut: true,
      elapsedMs: Date.now() - startTime,
      storeUpdate: {}
    };
  }

  async exists(session: StoredSession): Promise<'alive' | 'dead' | 'unknown'> {
    return this.raw.sessionExists(toTmuxSessionName(session.championId));
  }

  async getLastMessages(session: StoredSession, count: number): Promise<string[]> {
    const transcriptPath = getClaudeTranscriptPath(session.path, session.internalId);
    const transcriptEntries = await readClaudeTranscript(transcriptPath);
    const blocks = getAssistantTextBlocks(transcriptEntries);
    return blocks.slice(-Math.max(1, count));
  }

  async getLogs(session: StoredSession): Promise<SessionTurn[]> {
    const transcriptPath = getClaudeTranscriptPath(session.path, session.internalId);
    const entries = await readClaudeTranscript(transcriptPath);
    const turns: SessionTurn[] = [];

    for (const entry of entries) {
      const type = entry.type?.toLowerCase();
      if (type === 'human' || type === 'user') {
        const text = extractTextBlocks(entry.message?.content).join('\n\n');
        if (text) {
          turns.push({ role: 'human', text });
        }
      } else if (type === 'assistant') {
        const text = extractTextBlocks(entry.message?.content).join('\n\n');
        if (text) {
          turns.push({ role: 'assistant', text });
        }
      }
    }

    return turns;
  }

  async kill(session: StoredSession): Promise<void> {
    const tmuxSessionName = toTmuxSessionName(session.championId);
    try {
      await this.raw.killSession(tmuxSessionName);
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !/failed to connect server|no server running|can't find session/i.test(error.message)
      ) {
        throw error;
      }
    }
  }

  async afterKill(_remainingActiveSessions: StoredSession[]): Promise<void> {
    // No post-kill cleanup needed for Claude
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
