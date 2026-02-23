import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toTmuxSessionName } from '../../src/champion-ids';
import {
  readStoreSessions,
  runDevSessionsCli,
  runTmux,
  sessionExists,
  TMUX_AVAILABLE
} from './helpers';

const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

interface CliTestContext {
  rootDir: string;
  homeDir: string;
  workspaceDir: string;
  mockBinDir: string;
  env: NodeJS.ProcessEnv;
}

function getContext(context: CliTestContext | undefined): CliTestContext {
  if (!context) {
    throw new Error('Missing CLI integration test context');
  }

  return context;
}

async function createMockClaudeBinary(binDirectory: string): Promise<void> {
  const scriptPath = path.join(binDirectory, 'claude');
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'sleep 999'
  ].join('\n');

  await writeFile(scriptPath, script, 'utf8');
  await chmod(scriptPath, 0o755);
}

async function createContext(): Promise<CliTestContext> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-cli-e2e-'));
  const homeDir = path.join(rootDir, 'home');
  const workspaceDir = path.join(rootDir, 'workspace');
  const mockBinDir = path.join(rootDir, 'bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(mockBinDir, { recursive: true });
  await createMockClaudeBinary(mockBinDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${mockBinDir}${path.delimiter}${process.env.PATH ?? ''}`
  };

  return {
    rootDir,
    homeDir,
    workspaceDir,
    mockBinDir,
    env
  };
}

async function extractChampionId(homeDir: string): Promise<string> {
  const sessions = await readStoreSessions(homeDir);
  expect(sessions).toHaveLength(1);
  return sessions[0].championId;
}

async function cleanupContext(context: CliTestContext): Promise<void> {
  const sessions = await readStoreSessions(context.homeDir);

  await Promise.all(
    sessions.map(async (session) => {
      await runTmux(['kill-session', '-t', toTmuxSessionName(session.championId)], 5_000);
    })
  );

  await rm(context.rootDir, { recursive: true, force: true });
}

describeIfTmux('CLI e2e integration', () => {
  let context: CliTestContext | undefined;

  beforeEach(async () => {
    context = await createContext();
  });

  afterEach(async () => {
    if (context) {
      await cleanupContext(context);
      context = undefined;
    }
  });

  it(
    'creates a session with mock claude and persists store/tmux state',
    async () => {
      const activeContext = getContext(context);
      const createResult = await runDevSessionsCli(
        ['create', '--path', activeContext.workspaceDir, '--mode', 'yolo', '--quiet'],
        { env: activeContext.env, cwd: activeContext.workspaceDir }
      );

      expect(createResult.code).toBe(0);
      const championId = createResult.stdout.trim();
      expect(championId.length).toBeGreaterThan(0);

      const sessions = await readStoreSessions(activeContext.homeDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].championId).toBe(championId);
      expect(sessions[0].path).toBe(path.resolve(activeContext.workspaceDir));
      expect(sessions[0].cli).toBe('claude');

      const tmuxName = toTmuxSessionName(championId);
      expect(await sessionExists(tmuxName)).toBe(true);
    },
    30_000
  );

  it(
    'lists created sessions and prunes store entries when tmux session is gone',
    async () => {
      const activeContext = getContext(context);
      const createResult = await runDevSessionsCli(
        ['create', '--path', activeContext.workspaceDir, '--mode', 'yolo', '--quiet'],
        { env: activeContext.env, cwd: activeContext.workspaceDir }
      );
      expect(createResult.code).toBe(0);

      const championId = createResult.stdout.trim();
      const tmuxName = toTmuxSessionName(championId);

      const listResultBeforeKill = await runDevSessionsCli(['list'], {
        env: activeContext.env,
        cwd: activeContext.workspaceDir
      });
      expect(listResultBeforeKill.code).toBe(0);
      expect(listResultBeforeKill.stdout).toContain(championId);

      const tmuxKillResult = await runTmux(['kill-session', '-t', tmuxName], 5_000);
      expect(tmuxKillResult.code).toBe(0);

      const listResultAfterKill = await runDevSessionsCli(['list'], {
        env: activeContext.env,
        cwd: activeContext.workspaceDir
      });
      expect(listResultAfterKill.code).toBe(0);
      expect(listResultAfterKill.stdout).toContain('No active sessions');
      expect(listResultAfterKill.stdout).not.toContain(championId);

      const sessionsAfterPrune = await readStoreSessions(activeContext.homeDir);
      expect(sessionsAfterPrune).toEqual([]);
    },
    30_000
  );

  it(
    'kills sessions through CLI and removes store metadata',
    async () => {
      const activeContext = getContext(context);
      const createResult = await runDevSessionsCli(
        ['create', '--path', activeContext.workspaceDir, '--mode', 'yolo', '--quiet'],
        { env: activeContext.env, cwd: activeContext.workspaceDir }
      );
      expect(createResult.code).toBe(0);

      const championId = createResult.stdout.trim();
      const tmuxName = toTmuxSessionName(championId);
      expect(await sessionExists(tmuxName)).toBe(true);

      const killResult = await runDevSessionsCli(['kill', championId], {
        env: activeContext.env,
        cwd: activeContext.workspaceDir
      });
      expect(killResult.code).toBe(0);
      expect(killResult.stdout).toContain(`Killed session ${championId}`);
      expect(await sessionExists(tmuxName)).toBe(false);

      const sessions = await readStoreSessions(activeContext.homeDir);
      expect(sessions).toEqual([]);
    },
    30_000
  );

  it(
    'installs the skill into local Claude skills directory',
    async () => {
      const activeContext = getContext(context);
      const installResult = await runDevSessionsCli(['install-skill', '--local', '--claude'], {
        env: activeContext.env,
        cwd: activeContext.workspaceDir
      });

      expect(installResult.code).toBe(0);

      const destinationPath = path.join(
        activeContext.workspaceDir,
        '.claude',
        'skills',
        'dev-sessions',
        'SKILL.md'
      );
      const installedContent = await readFile(destinationPath, 'utf8');
      const sourceContent = await readFile(path.resolve('skills', 'dev-sessions', 'SKILL.md'), 'utf8');

      expect(installedContent).toBe(sourceContent);
    },
    30_000
  );

  it(
    'returns champion id from create output',
    async () => {
      const activeContext = getContext(context);
      const createResult = await runDevSessionsCli(
        ['create', '--path', activeContext.workspaceDir, '--mode', 'yolo'],
        { env: activeContext.env, cwd: activeContext.workspaceDir }
      );
      expect(createResult.code).toBe(0);
      expect(createResult.stdout).toMatch(/Created session [a-z0-9-]+/i);
      expect(await extractChampionId(activeContext.homeDir)).toBeTruthy();
    },
    30_000
  );
});
