import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeBackend } from '../../src/backends/claude-backend';
import { ClaudeTmuxBackend } from '../../src/backends/claude-tmux';
import { CodexBackend } from '../../src/backends/codex-backend';
import {
  CodexAppServerBackend,
  CodexSendResult,
  CodexTurnWaitResult
} from '../../src/backends/codex-appserver';
import { toTmuxSessionName } from '../../src/champion-ids';
import { SessionManager } from '../../src/session-manager';
import { SessionStore } from '../../src/session-store';
import { AgentTurnStatus, SessionMode } from '../../src/types';

interface CreateCall {
  tmuxSessionName: string;
  workspacePath: string;
  mode: SessionMode;
  sessionUuid: string;
}

class FakeClaudeBackend extends ClaudeTmuxBackend {
  readonly createCalls: CreateCall[] = [];
  readonly sendCalls: Array<{ tmuxSessionName: string; message: string }> = [];
  readonly killCalls: string[] = [];
  private readonly liveSessions = new Set<string>();

  constructor() {
    super(1);
  }

  override async createSession(
    tmuxSessionName: string,
    workspacePath: string,
    mode: SessionMode,
    sessionUuid: string
  ): Promise<void> {
    this.createCalls.push({
      tmuxSessionName,
      workspacePath,
      mode,
      sessionUuid
    });
    this.liveSessions.add(tmuxSessionName);
  }

  override async sendMessage(tmuxSessionName: string, message: string): Promise<void> {
    this.sendCalls.push({
      tmuxSessionName,
      message
    });
  }

  override async killSession(tmuxSessionName: string): Promise<void> {
    this.killCalls.push(tmuxSessionName);
    this.liveSessions.delete(tmuxSessionName);
  }

  override async sessionExists(tmuxSessionName: string): Promise<'alive' | 'dead' | 'unknown'> {
    return this.liveSessions.has(tmuxSessionName) ? 'alive' : 'dead';
  }
}

class FakeCodexBackend extends CodexAppServerBackend {
  readonly createCalls: Array<{ championId: string; workspacePath: string; model: string }> = [];
  readonly sendCalls: Array<{
    championId: string;
    threadId: string;
    message: string;
    options?: {
      workspacePath: string;
      model?: string;
    };
  }> = [];
  readonly killCalls: Array<{ championId: string; pid?: number }> = [];
  readonly sessionExistsCalls: Array<{ championId: string; pid?: number; port?: number; threadId?: string }> = [];
  readonly waitForThreadCalls: Array<{ championId: string; threadId: string; timeoutMs: number }> = [];
  readonly getLastAssistantMessagesCalls: Array<{ championId: string; threadId: string; count: number }> = [];
  readonly statuses = new Map<string, AgentTurnStatus>();
  readonly messages = new Map<string, string[]>();
  readonly liveSessions = new Set<string>();
  readonly threadIdToChampionId = new Map<string, string>();
  nextWaitForThreadResult: CodexTurnWaitResult = {
    completed: true,
    timedOut: false,
    elapsedMs: 25,
    status: 'completed'
  };
  nextWaitForThreadError?: Error;

  nextSendResult: CodexSendResult = {
    threadId: 'thr_default',
    appServerPid: 9001,
    appServerPort: 4510
  };

  constructor() {
    super(() => {
      throw new Error('Not used in FakeCodexBackend');
    });
  }

  override async createSession(
    championId: string,
    workspacePath: string,
    model: string = 'gpt-5.3-codex'
  ): Promise<{ threadId: string; model: string }> {
    this.createCalls.push({
      championId,
      workspacePath,
      model
    });
    this.liveSessions.add(championId);
    this.threadIdToChampionId.set(`thr_${championId}`, championId);
    return {
      threadId: `thr_${championId}`,
      model
    };
  }

  override async sendMessage(
    championId: string,
    threadId: string,
    message: string,
    options?: {
      workspacePath: string;
      model?: string;
    }
  ): Promise<CodexSendResult> {
    this.sendCalls.push({
      championId,
      threadId,
      message,
      options
    });
    const thread = this.nextSendResult.threadId === 'thr_default' ? threadId : this.nextSendResult.threadId;
    this.statuses.set(championId, 'working');
    return {
      ...this.nextSendResult,
      threadId: thread
    };
  }

  override async getLastAssistantMessages(championId: string, threadId: string, count: number): Promise<string[]> {
    this.getLastAssistantMessagesCalls.push({ championId, threadId, count });
    const values = this.messages.get(championId) ?? [];
    return values.slice(-Math.max(1, count));
  }

  override getSessionStatus(championId: string): AgentTurnStatus {
    return this.statuses.get(championId) ?? 'idle';
  }

  override async getThreadRuntimeStatus(threadId: string): Promise<'active' | 'idle' | 'notLoaded' | 'systemError' | 'unknown'> {
    const championId = this.threadIdToChampionId.get(threadId);
    if (!championId) return 'notLoaded';
    const status = this.statuses.get(championId) ?? 'idle';
    return status === 'working' ? 'active' : 'idle';
  }

  override async killSession(championId: string, pid?: number): Promise<void> {
    this.killCalls.push({ championId, pid });
    this.liveSessions.delete(championId);
  }

  override async waitForThread(
    championId: string,
    threadId: string,
    timeoutMs: number = 300_000
  ): Promise<CodexTurnWaitResult> {
    this.waitForThreadCalls.push({ championId, threadId, timeoutMs });
    if (this.nextWaitForThreadError) {
      const error = this.nextWaitForThreadError;
      this.nextWaitForThreadError = undefined;
      throw error;
    }

    const result = { ...this.nextWaitForThreadResult };
    this.statuses.set(championId, result.status === 'interrupted' ? 'working' : 'idle');
    return result;
  }

  override async sessionExists(championId: string, pid?: number, port?: number, threadId?: string): Promise<boolean> {
    this.sessionExistsCalls.push({ championId, pid, port, threadId });
    return this.liveSessions.has(championId);
  }
}

describe('SessionManager', () => {
  let tmpDir = '';
  let homeDir = '';
  let previousHome: string | undefined;
  let store: SessionStore;
  let backend: FakeClaudeBackend;
  let codexBackend: FakeCodexBackend;
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-manager-'));
    homeDir = path.join(tmpDir, 'home');
    await mkdir(homeDir, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    store = new SessionStore(path.join(tmpDir, 'sessions.json'));
    backend = new FakeClaudeBackend();
    codexBackend = new FakeCodexBackend();
    manager = new SessionManager(store, new ClaudeBackend(backend), new CodexBackend(codexBackend));
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('pre-assigns a UUID and passes it to claude startup', async () => {
    const session = await manager.createSession({
      path: '/tmp/project',
      mode: 'native',
      description: 'test create flow'
    });

    expect(session.internalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(backend.createCalls).toHaveLength(1);
    expect(backend.createCalls[0]).toEqual({
      tmuxSessionName: toTmuxSessionName(session.championId),
      workspacePath: '/tmp/project',
      mode: 'native',
      sessionUuid: session.internalId
    });
  });

  it('waits for a new assistant response instead of stale transcript state', async () => {
    const session = await manager.createSession({
      path: '/tmp/project',
      mode: 'native'
    });

    const transcriptDir = path.join(homeDir, '.claude', 'projects', '-tmp-project');
    const transcriptPath = path.join(transcriptDir, `${session.internalId}.jsonl`);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        '{"type":"human","message":{"content":"old task"}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"old done"}]}}'
      ].join('\n'),
      'utf8'
    );

    const waitPromise = manager.waitForSession(session.championId, {
      timeoutSeconds: 2,
      intervalSeconds: 0.05
    });

    setTimeout(() => {
      void appendFile(
        transcriptPath,
        '\n{"type":"human","message":{"content":"new task"}}',
        'utf8'
      );
    }, 20);

    setTimeout(() => {
      void appendFile(
        transcriptPath,
        '\n{"type":"assistant","message":{"content":[{"type":"text","text":"new done"}]}}',
        'utf8'
      );
    }, 120);

    const result = await waitPromise;

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it('returns immediately when latest user already has an assistant reply after last send timestamp', async () => {
    const session = await manager.createSession({
      path: '/tmp/project-ready',
      mode: 'native'
    });

    await store.updateSession(session.championId, {
      lastUsed: '2026-01-01T00:00:00.000Z'
    });

    const transcriptDir = path.join(homeDir, '.claude', 'projects', '-tmp-project-ready');
    const transcriptPath = path.join(transcriptDir, `${session.internalId}.jsonl`);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        '{"type":"user","timestamp":"2026-01-01T00:00:10.000Z","message":{"content":"run this"}}',
        '{"type":"assistant","timestamp":"2026-01-01T00:00:12.000Z","message":{"content":[{"type":"text","text":"done"}]}}'
      ].join('\n'),
      'utf8'
    );

    const result = await manager.waitForSession(session.championId, {
      timeoutSeconds: 5,
      intervalSeconds: 1
    });

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeLessThan(500);
  });

  it('routes codex sessions through codex app-server backend methods', async () => {
    const session = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-project',
      description: 'codex session',
      model: 'gpt-5.3-codex'
    });

    expect(session.cli).toBe('codex');
    expect(session.internalId).toBe(`thr_${session.championId}`);
    expect(session.appServerPid).toBeUndefined();
    expect(codexBackend.createCalls).toEqual([
      {
        championId: session.championId,
        workspacePath: '/tmp/codex-project',
        model: 'gpt-5.3-codex'
      }
    ]);

    await manager.sendMessage(session.championId, 'run lint');
    expect(codexBackend.sendCalls).toEqual([
      {
        championId: session.championId,
        threadId: session.internalId,
        message: 'run lint',
        options: {
          workspacePath: '/tmp/codex-project',
          model: 'gpt-5.3-codex'
        }
      }
    ]);

    // After non-blocking send, turn is in progress
    expect(await manager.getSessionStatus(session.championId)).toBe('working');

    // Wait for turn to complete
    const waitResult = await manager.waitForSession(session.championId, {
      timeoutSeconds: 3
    });

    expect(waitResult).toEqual({
      completed: true,
      timedOut: false,
      elapsedMs: 25
    });

    // After wait, status is idle
    expect(await manager.getSessionStatus(session.championId)).toBe('idle');

    // Set messages on backend for last-message fallback
    codexBackend.messages.set(session.championId, ['second']);
    expect(await manager.getLastAssistantTextBlocks(session.championId, 1)).toEqual(['second']);

    const stored = await store.getSession(session.championId);
    expect(stored?.lastTurnStatus).toBe('completed');
    expect(stored?.codexTurnInProgress).toBe(false);
  });

  it('uses the codex backend last-message fallback with the stored thread id when the session cache is empty', async () => {
    const session = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-history-fallback'
    });

    codexBackend.messages.set(session.championId, ['older reply', 'newer reply']);
    await store.updateSession(session.championId, {
      lastAssistantMessages: []
    });

    await expect(manager.getLastAssistantTextBlocks(session.championId, 1)).resolves.toEqual(['newer reply']);
    expect(codexBackend.getLastAssistantMessagesCalls).toEqual([
      {
        championId: session.championId,
        threadId: session.internalId,
        count: 1
      }
    ]);
  });

  it('refreshes codex last-message from backend when a completed turn may make store cache stale', async () => {
    const session = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-stale-last-message'
    });

    codexBackend.messages.set(session.championId, ['fresh reply']);
    await store.updateSession(session.championId, {
      lastAssistantMessages: ['stale cached reply'],
      lastTurnStatus: 'completed',
      codexTurnInProgress: false
    });

    await expect(manager.getLastAssistantTextBlocks(session.championId, 1)).resolves.toEqual(['fresh reply']);
    expect(codexBackend.getLastAssistantMessagesCalls).toEqual([
      {
        championId: session.championId,
        threadId: session.internalId,
        count: 1
      }
    ]);
  });

  it('reconnects on Codex wait when the store still shows a turn in progress', async () => {
    const session = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-stale-wait'
    });

    await store.updateSession(session.championId, {
      codexTurnInProgress: true,
      lastTurnStatus: 'interrupted',
      lastTurnError: 'Timed out waiting for Codex turn completion'
    });

    codexBackend.nextWaitForThreadResult = {
      completed: true,
      timedOut: false,
      elapsedMs: 123,
      status: 'completed'
    };

    const result = await manager.waitForSession(session.championId, {
      timeoutSeconds: 4
    });

    expect(result).toEqual({
      completed: true,
      timedOut: false,
      elapsedMs: 123
    });
    expect(codexBackend.waitForThreadCalls).toEqual([
      {
        championId: session.championId,
        threadId: session.internalId,
        timeoutMs: 4_000
      }
    ]);

    const stored = await store.getSession(session.championId);
    expect(stored?.codexTurnInProgress).toBe(false);
    expect(stored?.lastTurnStatus).toBe('completed');
    expect(stored?.lastTurnError).toBeUndefined();
  });

  it('throws when codex backend.sendMessage throws (connection error)', async () => {
    const session = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-project'
    });

    vi.spyOn(codexBackend, 'sendMessage').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(manager.sendMessage(session.championId, 'run failing task')).rejects
      .toThrow('ECONNREFUSED');

    const stored = await store.getSession(session.championId);
    expect(stored?.codexTurnInProgress).toBe(false);
    expect(stored?.lastTurnStatus).toBe('failed');
  });

  it('throws when codex wait fails', async () => {
    const session = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-project'
    });

    await manager.sendMessage(session.championId, 'run failing task');

    codexBackend.nextWaitForThreadResult = {
      completed: true,
      timedOut: false,
      elapsedMs: 31,
      status: 'failed',
      errorMessage: 'runtime error'
    };

    await expect(
      manager.waitForSession(session.championId, { timeoutSeconds: 2 })
    ).rejects.toThrow('Codex turn failed: runtime error');
  });

  it('returns timedOut when Claude transcript does not complete before timeout', async () => {
    const session = await manager.createSession({
      path: '/tmp/project-timeout',
      mode: 'native'
    });

    const transcriptDir = path.join(homeDir, '.claude', 'projects', '-tmp-project-timeout');
    const transcriptPath = path.join(transcriptDir, `${session.internalId}.jsonl`);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      transcriptPath,
      '{"type":"human","message":{"content":"long running task"}}',
      'utf8'
    );

    const waitResult = await manager.waitForSession(session.championId, {
      timeoutSeconds: 0.2,
      intervalSeconds: 0.05
    });

    expect(waitResult.completed).toBe(false);
    expect(waitResult.timedOut).toBe(true);
    expect(waitResult.elapsedMs).toBeGreaterThanOrEqual(200);
  });

  it('routes mixed Claude and Codex sessions to the correct backend and kill path', async () => {
    const claudeSession = await manager.createSession({
      path: '/tmp/claude-mixed',
      mode: 'native'
    });
    const codexSession = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-mixed'
    });

    const claudeTranscriptDir = path.join(homeDir, '.claude', 'projects', '-tmp-claude-mixed');
    const claudeTranscriptPath = path.join(claudeTranscriptDir, `${claudeSession.internalId}.jsonl`);
    await mkdir(claudeTranscriptDir, { recursive: true });
    await writeFile(
      claudeTranscriptPath,
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Claude says hi"}]}}',
      'utf8'
    );

    await manager.sendMessage(codexSession.championId, 'say hi');
    await manager.waitForSession(codexSession.championId, { timeoutSeconds: 3 });
    codexBackend.messages.set(codexSession.championId, ['Codex says hi']);

    const listed = await manager.listSessions();
    expect(listed.map((session) => session.championId).sort()).toEqual(
      [claudeSession.championId, codexSession.championId].sort()
    );
    expect(codexBackend.sessionExistsCalls).toContainEqual(
      expect.objectContaining({
        championId: codexSession.championId,
        threadId: codexSession.internalId
      })
    );

    expect(await manager.getSessionStatus(claudeSession.championId)).toBe('idle');
    expect(await manager.getSessionStatus(codexSession.championId)).toBe('idle');

    expect(await manager.getLastAssistantTextBlocks(claudeSession.championId, 1))
      .toEqual(['Claude says hi']);
    expect(await manager.getLastAssistantTextBlocks(codexSession.championId, 1))
      .toEqual(['Codex says hi']);

    await manager.killSession(codexSession.championId);
    await manager.killSession(claudeSession.championId);

    expect(codexBackend.killCalls).toEqual([
      {
        championId: codexSession.championId,
        pid: 9001
      }
    ]);
    expect(backend.killCalls).toEqual([toTmuxSessionName(claudeSession.championId)]);
    expect(await manager.listSessions()).toEqual([]);
  });

  it('preserves session record and logs a warning when sessionExists returns unknown', async () => {
    class UnstableBackend extends FakeClaudeBackend {
      override async sessionExists(): Promise<'alive' | 'dead' | 'unknown'> {
        return 'unknown';
      }
    }

    const unstableRaw = new UnstableBackend();
    const unstableManager = new SessionManager(store, new ClaudeBackend(unstableRaw), new CodexBackend(new FakeCodexBackend()));
    const session = await unstableManager.createSession({ path: tmpDir });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listed = await unstableManager.listSessions();
    expect(listed.map((s) => s.championId)).toContain(session.championId);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(session.championId));
    warnSpy.mockRestore();
  });

  it('throws session-not-found errors for unknown IDs', async () => {
    await expect(manager.getSessionStatus('missing-id')).rejects.toThrow('Session not found: missing-id');
    await expect(manager.sendMessage('missing-id', 'hello')).rejects.toThrow('Session not found: missing-id');
    await expect(manager.killSession('missing-id')).rejects.toThrow('Session not found: missing-id');
  });
});
