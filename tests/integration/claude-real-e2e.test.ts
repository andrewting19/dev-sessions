/**
 * Real Claude e2e tests — uses the actual claude binary, makes real API calls.
 *
 * Opt-in only: set RUN_REAL_CLAUDE_E2E=1 to run.
 * These tests are intentionally excluded from the default `npm test` run.
 *
 * Cleanup: each test removes its tmux session and the Claude transcript directory
 * created under the real ~/.claude/projects/. HOME is NOT overridden because the
 * tmux server always uses the real home regardless of env overrides.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toTmuxSessionName } from '../../src/champion-ids';
import { sanitizeWorkspacePath } from '../../src/transcript/claude-parser';
import { readStoreSessions, runDevSessionsCli, runTmux, TMUX_AVAILABLE } from './helpers';

const CLAUDE_AVAILABLE = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const RUN_REAL = process.env['RUN_REAL_CLAUDE_E2E'] === '1';

const describeIfReal = RUN_REAL && TMUX_AVAILABLE && CLAUDE_AVAILABLE
  ? describe
  : describe.skip;

interface RealE2EContext {
  workspaceDir: string;
  stateDir: string;
  championId: string | null;
}

function isolatedCliEnv(context: RealE2EContext): NodeJS.ProcessEnv {
  return {
    DEV_SESSIONS_STATE_PATH: path.join(context.stateDir, 'state.sqlite'),
    DEV_SESSIONS_STORE_PATH: path.join(context.stateDir, '.dev-sessions', 'sessions.json'),
    DEV_SESSIONS_AUTO_CLEANUP_HOURS: '0'
  };
}

describeIfReal('real Claude e2e', () => {
  let context: RealE2EContext;

  beforeEach(async () => {
    // Resolve symlinks so our sanitized path matches what claude uses internally.
    // On macOS, os.tmpdir() returns /var/folders/... which resolves to /private/var/folders/...
    const rawDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-real-e2e-'));
    const workspaceDir = await realpath(rawDir);
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-real-state-'));
    await mkdir(workspaceDir, { recursive: true });
    context = { workspaceDir, stateDir, championId: null };
  });

  afterEach(async () => {
    const { workspaceDir, stateDir, championId } = context;

    // Kill tmux session if one was created
    if (championId) {
      const tmuxName = toTmuxSessionName(championId);
      await runTmux(['kill-session', '-t', tmuxName], 5_000).catch(() => undefined);
    }

    // Remove workspace temp dir
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });

    // Remove Claude transcript directory for this workspace from the real home dir
    const transcriptProjectDir = path.join(
      os.homedir(),
      '.claude',
      'projects',
      sanitizeWorkspacePath(workspaceDir)
    );
    await rm(transcriptProjectDir, { recursive: true, force: true });
  });

  it(
    'create → send → wait → last-message round trip with real claude',
    async () => {
      // Create session
      const createResult = await runDevSessionsCli(
        ['create', '--path', context.workspaceDir, '--mode', 'native', '--quiet'],
        {
          cwd: context.workspaceDir,
          env: isolatedCliEnv(context),
          timeoutMs: 90_000
        }
      );
      expect(createResult.code, createResult.stderr).toBe(0);
      const championId = createResult.stdout.trim();
      expect(championId.length).toBeGreaterThan(0);
      context.championId = championId;

      // Verify it's in the store
      const sessions = await readStoreSessions(context.stateDir);
      const session = sessions.find((s) => s.championId === championId);
      expect(session).toBeDefined();
      const taskId = session!.internalId;

      // Send a deterministic prompt
      const sendResult = await runDevSessionsCli(
        [
          'send',
          championId,
          'Reply with exactly one word: PONG. No explanation, no punctuation, just the word PONG.'
        ],
        {
          cwd: context.workspaceDir,
          env: isolatedCliEnv(context),
          timeoutMs: 70_000
        }
      );
      expect(sendResult.code, sendResult.stderr).toBe(0);

      // Wait for turn completion
      const waitResult = await runDevSessionsCli(
        ['wait', championId, '--timeout', '90'],
        {
          cwd: context.workspaceDir,
          env: isolatedCliEnv(context),
          timeoutMs: 100_000
        }
      );
      expect(waitResult.code, waitResult.stderr).toBe(0);
      expect(waitResult.stdout.trim()).toBe('completed');

      // Read the response
      const lastMessageResult = await runDevSessionsCli(
        ['last-message', championId, '--count', '1'],
        {
          cwd: context.workspaceDir,
          env: isolatedCliEnv(context),
          timeoutMs: 70_000
        }
      );
      expect(lastMessageResult.code, lastMessageResult.stderr).toBe(0);
      expect(lastMessageResult.stdout.trim().toLowerCase()).toContain('pong');

      // Clean kill
      const killResult = await runDevSessionsCli(['kill', championId], {
        cwd: context.workspaceDir,
        env: isolatedCliEnv(context)
      });
      expect(killResult.code, killResult.stderr).toBe(0);
      context.championId = null;

      const resumeResult = await runDevSessionsCli(['resume', taskId, '--quiet'], {
        cwd: context.workspaceDir,
        env: isolatedCliEnv(context),
        timeoutMs: 90_000
      });
      expect(resumeResult.code, resumeResult.stderr).toBe(0);
      context.championId = resumeResult.stdout.trim();

      const resumedReply = await runDevSessionsCli(
        [
          'ask',
          context.championId,
          '--timeout',
          '90',
          '--',
          'Reply with exactly CLAUDE_RESUME_OK and no other text.'
        ],
        {
          cwd: context.workspaceDir,
          env: isolatedCliEnv(context),
          timeoutMs: 100_000
        }
      );
      expect(resumedReply.code, resumedReply.stderr).toBe(0);
      expect(resumedReply.stdout.trim()).toBe('CLAUDE_RESUME_OK');

      const resumedKill = await runDevSessionsCli(['kill', context.championId], {
        cwd: context.workspaceDir,
        env: isolatedCliEnv(context)
      });
      expect(resumedKill.code, resumedKill.stderr).toBe(0);
      context.championId = null;
    },
    240_000
  );

  it(
    'status transitions correctly across the session lifecycle',
    async () => {
      const createResult = await runDevSessionsCli(
        ['create', '--path', context.workspaceDir, '--mode', 'native', '--quiet'],
        {
          cwd: context.workspaceDir,
          env: isolatedCliEnv(context),
          timeoutMs: 90_000
        }
      );
      expect(createResult.code, createResult.stderr).toBe(0);
      const championId = createResult.stdout.trim();
      context.championId = championId;

      // Send a task
      await runDevSessionsCli(
        ['send', championId, 'Reply with exactly one word: PONG.'],
        {
          cwd: context.workspaceDir,
          env: isolatedCliEnv(context)
        }
      );

      // After send: status should be working OR idle (send is non-blocking; fast responses
      // may complete before this status check runs). Just verify the command succeeds.
      const statusAfterSend = await runDevSessionsCli(['status', championId], {
        cwd: context.workspaceDir,
        env: isolatedCliEnv(context)
      });
      expect(statusAfterSend.code, statusAfterSend.stderr).toBe(0);
      expect(['working', 'idle']).toContain(statusAfterSend.stdout.trim());

      // Wait for completion
      await runDevSessionsCli(
        ['wait', championId, '--timeout', '90'],
        {
          cwd: context.workspaceDir,
          env: isolatedCliEnv(context),
          timeoutMs: 100_000
        }
      );

      // After wait: should be idle again
      const statusAfterWait = await runDevSessionsCli(['status', championId], {
        cwd: context.workspaceDir,
        env: isolatedCliEnv(context)
      });
      expect(statusAfterWait.code, statusAfterWait.stderr).toBe(0);
      expect(statusAfterWait.stdout.trim()).toBe('idle');

      await runDevSessionsCli(['kill', championId], {
        cwd: context.workspaceDir,
        env: isolatedCliEnv(context)
      });
      context.championId = null;
    },
    120_000
  );
});
