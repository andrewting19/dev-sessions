import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeTmuxBackend } from '../../src/backends/claude-tmux';
import { toTmuxSessionName } from '../../src/champion-ids';
import { SessionManager } from '../../src/session-manager';
import { SessionStore } from '../../src/session-store';
import { SessionMode } from '../../src/types';

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

describe('SessionManager', () => {
  let tmpDir = '';
  let homeDir = '';
  let previousHome: string | undefined;
  let store: SessionStore;
  let backend: FakeClaudeBackend;
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-manager-'));
    homeDir = path.join(tmpDir, 'home');
    await mkdir(homeDir, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    store = new SessionStore(path.join(tmpDir, 'sessions.json'));
    backend = new FakeClaudeBackend();
    manager = new SessionManager(store, backend);
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
});
