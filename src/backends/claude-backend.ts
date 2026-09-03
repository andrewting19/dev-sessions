import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { toTmuxSessionName } from '../champion-ids';
import {
  countHumanMessages,
  countSystemEntries,
  extractTextBlocks,
  getAssistantTextBlocks,
  getClaudeTranscriptPath,
  inferTranscriptStatus,
  readClaudeTranscript
} from '../transcript/claude-parser';
import { AgentTurnStatus, SessionCli, SessionTurn, StoredSession } from '../types';
import {
  Backend,
  BackendCreateOptions,
  BackendCreateResult,
  BackendResumeOptions,
  BackendStatusResult,
  BackendWaitResult
} from './backend';
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

  async resume(options: BackendResumeOptions): Promise<BackendCreateResult> {
    const mode = options.mode ?? 'native';
    const tmuxSessionName = toTmuxSessionName(options.championId);
    await this.raw.resumeSession(tmuxSessionName, options.workspacePath, mode, options.taskId);
    return { internalId: options.taskId, mode };
  }

  async retire(session: StoredSession): Promise<void> {
    await this.kill(session);
  }

  async preSendStoreFields(session: StoredSession, _sendTime: string): Promise<Partial<StoredSession>> {
    // Snapshot the current system entry count so wait() knows the baseline
    // even if it starts after the turn has already completed.
    const transcriptPath = getClaudeTranscriptPath(session.path, session.internalId);
    try {
      const entries = await readClaudeTranscript(transcriptPath);
      return { claudeSystemCountAtSend: countSystemEntries(entries) };
    } catch {
      return { claudeSystemCountAtSend: 0 };
    }
  }

  async send(session: StoredSession, message: string): Promise<Partial<StoredSession>> {
    const tmuxSessionName = toTmuxSessionName(session.championId);
    const sendTime = new Date().toISOString();
    const transcriptPath = getClaudeTranscriptPath(session.path, session.internalId);
    const baselineHumanCount = countHumanMessages(await readClaudeTranscript(transcriptPath));
    await this.raw.sendMessage(tmuxSessionName, message);
    await this.waitForMessageAcceptance(tmuxSessionName, transcriptPath, baselineHumanCount);
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
    const tmuxSessionName = toTmuxSessionName(session.championId);
    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    // Use the system entry count snapshotted at send time as the baseline.
    // This way wait() detects completion even if the turn finishes before wait starts.
    const baselineSystemCount = session.claudeSystemCountAtSend ?? 0;

    let lastMtimeMs = -1;
    let shouldReadTranscript = false;
    let cachedEntries: Awaited<ReturnType<typeof readClaudeTranscript>> = [];
    let pollCount = 0;

    while (Date.now() <= deadline) {
      // Periodically check if the tmux session is still alive (every 10th poll).
      if (pollCount > 0 && pollCount % 10 === 0) {
        const liveness = await this.raw.sessionExists(tmuxSessionName);
        if (liveness === 'dead') {
          return {
            completed: false,
            timedOut: false,
            elapsedMs: Date.now() - startTime,
            storeUpdate: { status: 'inactive', lastTurnError: 'tmux session died during wait' },
            errorToThrow: new Error('tmux session died during wait')
          };
        }
      }
      pollCount++;

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

      // A system entry is the definitive turn-completion signal — Claude writes it only
      // when the agent fully finishes (never mid-turn during tool calls).
      // Compare against the baseline from send time so we detect completion even if
      // the turn finishes before wait starts.
      const currentSystemCount = countSystemEntries(cachedEntries);
      if (currentSystemCount > baselineSystemCount) {
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

  private async waitForMessageAcceptance(
    tmuxSessionName: string,
    transcriptPath: string,
    baselineHumanCount: number
  ): Promise<void> {
    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const entries = await readClaudeTranscript(transcriptPath);
        if (countHumanMessages(entries) > baselineHumanCount) {
          return;
        }
        await this.sleep(100);
      }

      if ((await this.raw.sessionExists(tmuxSessionName)) === 'dead') {
        throw new Error('Claude exited before it accepted the message');
      }
      if (attempt < attempts - 1) {
        await this.raw.submitMessage(tmuxSessionName);
      }
    }

    throw new Error('Claude did not accept the message after three submit attempts');
  }
}
