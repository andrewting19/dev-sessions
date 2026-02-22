import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeTmuxBackend } from '../../src/backends/claude-tmux';
import { CodexAppServerBackend, CodexTurnSendResult } from '../../src/backends/codex-appserver';
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

  override async sessionExists(tmuxSessionName: string): Promise<boolean> {
    return this.liveSessions.has(tmuxSessionName);
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
      timeoutMs?: number;
    };
  }> = [];
  readonly killCalls: Array<{ championId: string; pid?: number }> = [];
  readonly sessionExistsCalls: Array<{ championId: string; pid?: number }> = [];
  readonly statuses = new Map<string, AgentTurnStatus>();
  readonly messages = new Map<string, string[]>();
  readonly liveSessions = new Set<string>();

  nextSendResult: CodexTurnSendResult = {
    threadId: 'thr_default',
    completed: true,
    timedOut: false,
    elapsedMs: 25,
    status: 'completed',
    assistantMessage: 'done'
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
      timeoutMs?: number;
    }
  ): Promise<CodexTurnSendResult> {
    this.sendCalls.push({
      championId,
      threadId,
      message,
      options
    });
    const thread = this.nextSendResult.threadId === 'thr_default' ? threadId : this.nextSendResult.threadId;
    const result = {
      ...this.nextSendResult,
      threadId: thread
    };

    this.statuses.set(championId, result.status === 'interrupted' ? 'working' : 'idle');
    if (result.assistantMessage.length > 0) {
      const values = this.messages.get(championId) ?? [];
      values.push(result.assistantMessage);
      this.messages.set(championId, values);
    }

    return result;
  }

  override getLastAssistantMessages(championId: string, count: number): string[] {
    const values = this.messages.get(championId) ?? [];
    return values.slice(-Math.max(1, count));
  }

  override getSessionStatus(championId: string): AgentTurnStatus {
    return this.statuses.get(championId) ?? 'idle';
  }

  override async killSession(championId: string, pid?: number): Promise<void> {
    this.killCalls.push({ championId, pid });
    this.liveSessions.delete(championId);
  }

  override async sessionExists(championId: string, pid?: number): Promise<boolean> {
    this.sessionExistsCalls.push({ championId, pid });
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
    manager = new SessionManager(store, backend, codexBackend);
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
      mode: 'yolo'
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
      timeoutSeconds: 5,
      intervalSeconds: 1
    });

    setTimeout(() => {
      void appendFile(
        transcriptPath,
        '\n{"type":"human","message":{"content":"new task"}}',
        'utf8'
      );
    }, 200);

    setTimeout(() => {
      void appendFile(
        transcriptPath,
        '\n{"type":"assistant","message":{"content":[{"type":"text","text":"new done"}]}}',
        'utf8'
      );
    }, 1200);

    const result = await waitPromise;

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1800);
  });

  it('returns immediately when latest user already has an assistant reply after last send timestamp', async () => {
    const session = await manager.createSession({
      path: '/tmp/project-ready',
      mode: 'yolo'
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

    codexBackend.nextSendResult = {
      threadId: `thr_${session.championId}`,
      completed: true,
      timedOut: false,
      elapsedMs: 77,
      status: 'completed',
      assistantMessage: 'second'
    };
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

    expect(await manager.getLastAssistantTextBlocks(session.championId, 1)).toEqual(['second']);

    expect(await manager.getSessionStatus(session.championId)).toBe('idle');
    const waitResult = await manager.waitForSession(session.championId, {
      timeoutSeconds: 3
    });

    expect(waitResult).toEqual({
      completed: true,
      timedOut: false,
      elapsedMs: 0
    });

    const stored = await store.getSession(session.championId);
    expect(stored?.lastTurnStatus).toBe('completed');
    expect(stored?.lastAssistantMessages).toEqual(['second']);
  });

  it('throws when codex turn fails', async () => {
    const session = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-project'
    });

    codexBackend.nextSendResult = {
      threadId: session.internalId,
      completed: true,
      timedOut: false,
      elapsedMs: 31,
      status: 'failed',
      errorMessage: 'runtime error',
      assistantMessage: ''
    };

    await expect(manager.sendMessage(session.championId, 'run failing task')).rejects
      .toThrow('Codex turn failed: runtime error');

    await expect(
      manager.waitForSession(session.championId, {
        timeoutSeconds: 2
      })
    ).rejects.toThrow('Codex turn failed: runtime error');
  });

  it('returns timedOut when Claude transcript does not complete before timeout', async () => {
    const session = await manager.createSession({
      path: '/tmp/project-timeout',
      mode: 'yolo'
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
      timeoutSeconds: 1,
      intervalSeconds: 1
    });

    expect(waitResult.completed).toBe(false);
    expect(waitResult.timedOut).toBe(true);
    expect(waitResult.elapsedMs).toBeGreaterThanOrEqual(1_000);
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

    codexBackend.nextSendResult = {
      threadId: codexSession.internalId,
      completed: true,
      timedOut: false,
      elapsedMs: 21,
      status: 'completed',
      assistantMessage: 'Codex says hi'
    };
    await manager.sendMessage(codexSession.championId, 'say hi');

    const listed = await manager.listSessions();
    expect(listed.map((session) => session.championId).sort()).toEqual(
      [claudeSession.championId, codexSession.championId].sort()
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
        pid: undefined
      }
    ]);
    expect(backend.killCalls).toEqual([toTmuxSessionName(claudeSession.championId)]);
    expect(await manager.listSessions()).toEqual([]);
  });

  it('throws session-not-found errors for unknown IDs', async () => {
    await expect(manager.getSessionStatus('missing-id')).rejects.toThrow('Session not found: missing-id');
    await expect(manager.sendMessage('missing-id', 'hello')).rejects.toThrow('Session not found: missing-id');
    await expect(manager.killSession('missing-id')).rejects.toThrow('Session not found: missing-id');
  });
});
