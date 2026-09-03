/**
 * Real Codex e2e test. This uses the installed Codex app-server and account.
 *
 * Opt in with RUN_REAL_CODEX_E2E=1.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodexAppServerBackend,
  DefaultCodexAppServerDaemonManager
} from '../../src/backends/codex-appserver';
import { runDevSessionsCli } from './helpers';

const CODEX_AVAILABLE = (() => {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const describeIfReal = process.env['RUN_REAL_CODEX_E2E'] === '1' && CODEX_AVAILABLE
  ? describe
  : describe.skip;

describeIfReal('real Codex CLI e2e', () => {
  let workspaceDir = '';
  let stateDir = '';
  let activeSessionId: string | undefined;
  let taskIdForCleanup: string | undefined;
  let appServerPid: number | undefined;
  let appServerPort: number | undefined;

  const cliEnv = (): NodeJS.ProcessEnv => ({
    DEV_SESSIONS_STATE_PATH: path.join(stateDir, 'state.sqlite'),
    DEV_SESSIONS_STORE_PATH: path.join(stateDir, 'sessions.json'),
    DEV_SESSIONS_CODEX_DAEMON_STATE_PATH: path.join(stateDir, 'codex-appserver.json'),
    DEV_SESSIONS_CODEX_DAEMON_LOG_PATH: path.join(stateDir, 'codex-appserver.log'),
    DEV_SESSIONS_AUTO_CLEANUP_HOURS: '0'
  });

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-codex-real-'));
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-codex-state-'));
    taskIdForCleanup = undefined;
    appServerPid = undefined;
    appServerPort = undefined;
  });

  afterEach(async () => {
    if (taskIdForCleanup) {
      const daemonManager = new DefaultCodexAppServerDaemonManager(
        path.join(stateDir, 'codex-appserver.json'),
        path.join(stateDir, 'codex-appserver.log')
      );
      await new CodexAppServerBackend({ daemonManager }).killSession(
        'real-e2e-cleanup',
        appServerPid,
        taskIdForCleanup,
        appServerPort
      ).catch(() => undefined);
    }
    if (activeSessionId) {
      await runDevSessionsCli(['kill', activeSessionId], {
        cwd: workspaceDir,
        env: cliEnv()
      }).catch(() => undefined);
    }
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it('keeps one thread ID across first send, kill, resume, and a second turn', async () => {
    const created = await runDevSessionsCli(
      ['create', '--cli', 'codex', '--path', workspaceDir, '--quiet'],
      { cwd: workspaceDir, env: cliEnv(), timeoutMs: 60_000 }
    );
    expect(created.code, created.stderr).toBe(0);
    activeSessionId = created.stdout.trim();

    const initialInspect = await runDevSessionsCli(['inspect', activeSessionId], {
      cwd: workspaceDir,
      env: cliEnv()
    });
    expect(initialInspect.code, initialInspect.stderr).toBe(0);
    const initialSession = JSON.parse(initialInspect.stdout) as {
      internalId: string;
      appServerPid?: number;
      appServerPort?: number;
    };
    const taskId = initialSession.internalId;
    taskIdForCleanup = taskId;
    appServerPid = initialSession.appServerPid;
    appServerPort = initialSession.appServerPort;

    const first = await runDevSessionsCli([
      'ask', activeSessionId,
      '--timeout', '180',
      '--idempotency-key', 'real-codex-first',
      '--',
      'Reply with exactly CODEX_REAL_FIRST_OK and no other text.'
    ], { cwd: workspaceDir, env: cliEnv(), timeoutMs: 200_000 });
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout.trim()).toBe('CODEX_REAL_FIRST_OK');

    const afterSendInspect = await runDevSessionsCli(['inspect', activeSessionId], {
      cwd: workspaceDir,
      env: cliEnv()
    });
    expect(afterSendInspect.code, afterSendInspect.stderr).toBe(0);
    expect((JSON.parse(afterSendInspect.stdout) as { internalId: string }).internalId).toBe(taskId);

    const killed = await runDevSessionsCli(['kill', activeSessionId], {
      cwd: workspaceDir,
      env: cliEnv()
    });
    expect(killed.code, killed.stderr).toBe(0);
    activeSessionId = undefined;

    const resumed = await runDevSessionsCli(['resume', taskId, '--quiet'], {
      cwd: workspaceDir,
      env: cliEnv(),
      timeoutMs: 60_000
    });
    expect(resumed.code, resumed.stderr).toBe(0);
    activeSessionId = resumed.stdout.trim();

    const second = await runDevSessionsCli([
      'ask', activeSessionId,
      '--timeout', '180',
      '--idempotency-key', 'real-codex-second',
      '--',
      'Reply with exactly CODEX_REAL_RESUME_OK and no other text.'
    ], { cwd: workspaceDir, env: cliEnv(), timeoutMs: 200_000 });
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout.trim()).toBe('CODEX_REAL_RESUME_OK');

    const finalInspect = await runDevSessionsCli(['inspect', activeSessionId], {
      cwd: workspaceDir,
      env: cliEnv()
    });
    expect(finalInspect.code, finalInspect.stderr).toBe(0);
    const finalSession = JSON.parse(finalInspect.stdout) as {
      internalId: string;
      appServerPid?: number;
      appServerPort?: number;
    };
    expect(finalSession.internalId).toBe(taskId);
    appServerPid = finalSession.appServerPid;
    appServerPort = finalSession.appServerPort;

  }, 300_000);
});
