import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeTmuxBackend } from '../../src/backends/claude-tmux';
import { CodexAppServerBackend, CodexTurnWaitResult } from '../../src/backends/codex-appserver';
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

  override async sendMessage(): Promise<void> {}

  override async killSession(tmuxSessionName: string): Promise<void> {
    this.liveSessions.delete(tmuxSessionName);
  }

  override async sessionExists(tmuxSessionName: string): Promise<boolean> {
    return this.liveSessions.has(tmuxSessionName);
  }
}

class FakeCodexBackend extends CodexAppServerBackend {
  readonly createCalls: Array<{ championId: string; workspacePath: string; model: string }> = [];
  readonly sendCalls: Array<{ championId: string; threadId: string; message: string }> = [];
  readonly waitCalls: Array<{ championId: string; timeoutMs: number }> = [];
  readonly killCalls: Array<{ championId: string; pid?: number }> = [];
  readonly sessionExistsCalls: Array<{ championId: string; pid?: number }> = [];
  readonly statuses = new Map<string, AgentTurnStatus>();
  readonly messages = new Map<string, string[]>();
  readonly liveSessions = new Set<string>();

  nextWaitResult: CodexTurnWaitResult = {
    completed: true,
    timedOut: false,
    elapsedMs: 25,
    status: 'completed'
  };

  constructor() {
    super(() => {
      throw new Error('Not used in FakeCodexBackend');
    });
  }

  override async createSession(
    championId: string,
    workspacePath: string,
    model: string = 'o4-mini'
  ): Promise<{ threadId: string; pid: number; model: string }> {
    this.createCalls.push({
      championId,
      workspacePath,
      model
    });
    this.liveSessions.add(championId);
    return {
      threadId: `thr_${championId}`,
      pid: 8181,
      model
    };
  }

  override async sendMessage(championId: string, threadId: string, message: string): Promise<void> {
    this.sendCalls.push({
      championId,
      threadId,
      message
    });
  }

  override async waitForTurn(championId: string, timeoutMs: number): Promise<CodexTurnWaitResult> {
    this.waitCalls.push({
      championId,
      timeoutMs
    });
    return this.nextWaitResult;
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

  it('routes codex sessions through codex app-server backend methods', async () => {
    const session = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-project',
      description: 'codex session',
      model: 'o4-mini'
    });

    expect(session.cli).toBe('codex');
    expect(session.internalId).toBe(`thr_${session.championId}`);
    expect(session.appServerPid).toBe(8181);
    expect(codexBackend.createCalls).toEqual([
      {
        championId: session.championId,
        workspacePath: '/tmp/codex-project',
        model: 'o4-mini'
      }
    ]);

    await manager.sendMessage(session.championId, 'run lint');
    expect(codexBackend.sendCalls).toEqual([
      {
        championId: session.championId,
        threadId: session.internalId,
        message: 'run lint'
      }
    ]);

    codexBackend.messages.set(session.championId, ['first', 'second']);
    expect(await manager.getLastAssistantTextBlocks(session.championId, 1)).toEqual(['second']);

    codexBackend.statuses.set(session.championId, 'working');
    expect(await manager.getSessionStatus(session.championId)).toBe('working');

    codexBackend.nextWaitResult = {
      completed: true,
      timedOut: false,
      elapsedMs: 77,
      status: 'completed'
    };
    const waitResult = await manager.waitForSession(session.championId, {
      timeoutSeconds: 3
    });

    expect(waitResult).toEqual({
      completed: true,
      timedOut: false,
      elapsedMs: 77
    });
    expect(codexBackend.waitCalls).toEqual([
      {
        championId: session.championId,
        timeoutMs: 3000
      }
    ]);

    const stored = await store.getSession(session.championId);
    expect(stored?.lastTurnStatus).toBe('completed');
  });

  it('throws when codex turn fails', async () => {
    const session = await manager.createSession({
      cli: 'codex',
      path: '/tmp/codex-project'
    });

    codexBackend.nextWaitResult = {
      completed: true,
      timedOut: false,
      elapsedMs: 31,
      status: 'failed',
      errorMessage: 'runtime error'
    };

    await expect(
      manager.waitForSession(session.championId, {
        timeoutSeconds: 2
      })
    ).rejects.toThrow('Codex turn failed: runtime error');
  });
});
