import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getClaudeTranscriptPath,
  sanitizeWorkspacePath
} from '../../src/transcript/claude-parser';
import { StoredSession } from '../../src/types';
import { runDevSessionsCli, writeStoreSessions } from './helpers';

interface TranscriptContext {
  rootDir: string;
  homeDir: string;
  workspacePath: string;
  env: NodeJS.ProcessEnv;
}

function createSessionRecord(championId: string, internalId: string, workspacePath: string): StoredSession {
  const now = new Date().toISOString();
  return {
    championId,
    internalId,
    cli: 'claude',
    mode: 'yolo',
    path: workspacePath,
    description: 'integration transcript session',
    status: 'active',
    createdAt: now,
    lastUsed: now
  };
}

function toJsonlLine(entry: unknown): string {
  return JSON.stringify(entry);
}

describe('transcript parsing integration', () => {
  let context: TranscriptContext;

  beforeEach(async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-transcript-'));
    const homeDir = path.join(rootDir, 'home');
    const workspacePath = path.join(rootDir, 'workspace');

    await mkdir(homeDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });

    context = {
      rootDir,
      homeDir,
      workspacePath,
      env: {
        ...process.env,
        HOME: homeDir
      }
    };
  });

  afterEach(async () => {
    await rm(context.rootDir, { recursive: true, force: true });
  });

  it(
    'handles full transcript lifecycle for last-message, status, and wait',
    async () => {
      const championId = 'dev-test-transcript';
      const internalId = '00000000-0000-4000-8000-000000000001';
      const session = createSessionRecord(championId, internalId, context.workspacePath);
      await writeStoreSessions(context.homeDir, [session]);

      const transcriptPath = getClaudeTranscriptPath(context.workspacePath, internalId, context.homeDir);
      await mkdir(path.dirname(transcriptPath), { recursive: true });
      await writeFile(
        transcriptPath,
        [
          toJsonlLine({ type: 'human', message: { content: 'old task' } }),
          toJsonlLine({
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'old done' }]
            }
          }),
          toJsonlLine({ type: 'human', message: { content: 'new task' } })
        ].join('\n'),
        'utf8'
      );

      const lastMessageBeforeWait = await runDevSessionsCli(['last-message', championId, '--count', '1'], {
        env: context.env
      });
      expect(lastMessageBeforeWait.code).toBe(0);
      expect(lastMessageBeforeWait.stdout.trim()).toBe('old done');

      const statusBeforeWait = await runDevSessionsCli(['status', championId], {
        env: context.env
      });
      expect(statusBeforeWait.code).toBe(0);
      expect(statusBeforeWait.stdout.trim()).toBe('working');

      const appendTimer = setTimeout(() => {
        void appendFile(
          transcriptPath,
          `\n${toJsonlLine({
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'new done' }]
            }
          })}`,
          'utf8'
        );
      }, 1_200);

      const waitResult = await runDevSessionsCli(
        ['wait', championId, '--timeout', '15', '--interval', '1'],
        { env: context.env, timeoutMs: 20_000 }
      );
      clearTimeout(appendTimer);
      expect(waitResult.code).toBe(0);
      expect(waitResult.stdout.trim()).toBe('completed');

      const statusAfterWait = await runDevSessionsCli(['status', championId], {
        env: context.env
      });
      expect(statusAfterWait.code).toBe(0);
      expect(statusAfterWait.stdout.trim()).toBe('idle');

      const lastMessageAfterWait = await runDevSessionsCli(['last-message', championId, '--count', '1'], {
        env: context.env
      });
      expect(lastMessageAfterWait.code).toBe(0);
      expect(lastMessageAfterWait.stdout.trim()).toBe('new done');
    },
    30_000
  );

  it('sanitizes real Claude workspace paths into transcript project directory names', () => {
    expect(sanitizeWorkspacePath('/Users/andrew/Documents/git_repos/dev-sessions'))
      .toBe('-Users-andrew-Documents-git-repos-dev-sessions');
    expect(sanitizeWorkspacePath('/Users/andrew/Documents/git_repos/claude-ting'))
      .toBe('-Users-andrew-Documents-git-repos-claude-ting');
  });
});
