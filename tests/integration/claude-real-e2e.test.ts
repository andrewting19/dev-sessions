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
  championId: string | null;
}

describeIfReal('real Claude e2e', () => {
  let context: RealE2EContext;

  beforeEach(async () => {
    // Resolve symlinks so our sanitized path matches what claude uses internally.
    // On macOS, os.tmpdir() returns /var/folders/... which resolves to /private/var/folders/...
    const rawDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-real-e2e-'));
    const workspaceDir = await realpath(rawDir);
    await mkdir(workspaceDir, { recursive: true });
    context = { workspaceDir, championId: null };
  });

  afterEach(async () => {
    const { workspaceDir, championId } = context;

    // Kill tmux session if one was created
    if (championId) {
      const tmuxName = toTmuxSessionName(championId);
      await runTmux(['kill-session', '-t', tmuxName], 5_000).catch(() => undefined);
    }

    // Remove workspace temp dir
    await rm(workspaceDir, { recursive: true, force: true });

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
        { cwd: context.workspaceDir }
      );
      expect(createResult.code).toBe(0);
      const championId = createResult.stdout.trim();
      expect(championId.length).toBeGreaterThan(0);
      context.championId = championId;

      // Verify it's in the store
      const sessions = await readStoreSessions(os.homedir());
      const session = sessions.find((s) => s.championId === championId);
      expect(session).toBeDefined();

      // Send a deterministic prompt
      const sendResult = await runDevSessionsCli(
        [
          'send',
          championId,
          'Reply with exactly one word: PONG. No explanation, no punctuation, just the word PONG.'
        ],
        { cwd: context.workspaceDir }
      );
      expect(sendResult.code).toBe(0);

      // Wait for turn completion
      const waitResult = await runDevSessionsCli(
        ['wait', championId, '--timeout', '90'],
        { cwd: context.workspaceDir, timeoutMs: 100_000 }
      );
      expect(waitResult.code).toBe(0);
      expect(waitResult.stdout.trim()).toBe('completed');

      // Read the response
      const lastMessageResult = await runDevSessionsCli(
        ['last-message', championId, '--count', '1'],
        { cwd: context.workspaceDir }
      );
      expect(lastMessageResult.code).toBe(0);
      expect(lastMessageResult.stdout.trim().toLowerCase()).toContain('pong');

      // Clean kill
      const killResult = await runDevSessionsCli(['kill', championId], { cwd: context.workspaceDir });
      expect(killResult.code).toBe(0);
      context.championId = null;
    },
    120_000
  );

  it(
    'status transitions correctly across the session lifecycle',
    async () => {
      const createResult = await runDevSessionsCli(
        ['create', '--path', context.workspaceDir, '--mode', 'native', '--quiet'],
        { cwd: context.workspaceDir }
      );
      expect(createResult.code).toBe(0);
      const championId = createResult.stdout.trim();
      context.championId = championId;

      // Send a task
      await runDevSessionsCli(
        ['send', championId, 'Reply with exactly one word: PONG.'],
        { cwd: context.workspaceDir }
      );

      // After send: status should be working OR idle (send is non-blocking; fast responses
      // may complete before this status check runs). Just verify the command succeeds.
      const statusAfterSend = await runDevSessionsCli(['status', championId], {
        cwd: context.workspaceDir
      });
      expect(statusAfterSend.code).toBe(0);
      expect(['working', 'idle']).toContain(statusAfterSend.stdout.trim());

      // Wait for completion
      await runDevSessionsCli(
        ['wait', championId, '--timeout', '90'],
        { cwd: context.workspaceDir, timeoutMs: 100_000 }
      );

      // After wait: should be idle again
      const statusAfterWait = await runDevSessionsCli(['status', championId], {
        cwd: context.workspaceDir
      });
      expect(statusAfterWait.code).toBe(0);
      expect(statusAfterWait.stdout.trim()).toBe('idle');

      await runDevSessionsCli(['kill', championId], { cwd: context.workspaceDir });
      context.championId = null;
    },
    120_000
  );
});
