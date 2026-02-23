import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDevSessionsCli } from './helpers';

interface InstallSkillContext {
  rootDir: string;
  homeDir: string;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
}

describe('install-skill integration', () => {
  let context: InstallSkillContext | undefined;

  beforeEach(async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-install-skill-'));
    const homeDir = path.join(rootDir, 'home');
    const workspaceDir = path.join(rootDir, 'workspace');

    await mkdir(homeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    context = {
      rootDir,
      homeDir,
      workspaceDir,
      env: {
        ...process.env,
        HOME: homeDir
      }
    };
  });

  afterEach(async () => {
    if (context) {
      await rm(context.rootDir, { recursive: true, force: true });
      context = undefined;
    }
  });

  it('installs the skill into ~/.codex/skills/dev-sessions/SKILL.md', async () => {
    if (!context) {
      throw new Error('Missing install-skill integration context');
    }

    const result = await runDevSessionsCli(['install-skill', '--codex'], {
      env: context.env,
      cwd: context.workspaceDir
    });

    expect(result.code).toBe(0);

    const installedPath = path.join(
      context.homeDir,
      '.codex',
      'skills',
      'dev-sessions',
      'SKILL.md'
    );
    const installedContent = await readFile(installedPath, 'utf8');
    const sourceContent = await readFile(path.resolve('skills', 'dev-sessions', 'SKILL.md'), 'utf8');

    expect(installedContent).toBe(sourceContent);
  });
});
