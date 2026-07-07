import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, BuildProgramDependencies, SessionManagerLike } from '../../src/cli';
import { StoredSession } from '../../src/types';

function createMockSession(championId: string): StoredSession {
  const now = '2026-02-21T00:00:00.000Z';
  return {
    championId,
    internalId: `${championId}-uuid`,
    cli: 'claude',
    mode: 'native',
    path: '/tmp/workspace',
    description: 'test session',
    status: 'active',
    createdAt: now,
    lastUsed: now
  };
}

function createManagerMock(): SessionManagerLike {
  return {
    createSession: vi.fn().mockResolvedValue(createMockSession('fizz-top')),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([createMockSession('fizz-top')]),
    getLastAssistantTextBlocks: vi.fn().mockResolvedValue(['done']),
    getSessionStatus: vi.fn().mockResolvedValue('idle'),
    waitForSession: vi.fn().mockResolvedValue({ completed: true, timedOut: false, elapsedMs: 1000 }),
    getSessionLogs: vi.fn().mockResolvedValue([
      { role: 'human', text: 'hello' },
      { role: 'assistant', text: 'world' }
    ]),
    inspectSession: vi.fn().mockResolvedValue(createMockSession('fizz-top')),
    setSessionGoal: vi.fn().mockResolvedValue(createMockGoal('active')),
    getSessionGoal: vi.fn().mockResolvedValue(createMockGoal('active')),
    clearSessionGoal: vi.fn().mockResolvedValue(true),
    waitForSessionGoal: vi.fn().mockResolvedValue({
      goal: createMockGoal('complete'),
      timedOut: false,
      elapsedMs: 1000
    }),
    waitForSessionNextTurn: vi.fn().mockResolvedValue({ completed: true, timedOut: false, elapsedMs: 500 })
  };
}

function createMockGoal(status: 'active' | 'paused' | 'complete') {
  return {
    threadId: 'thr_1',
    objective: 'ship the feature',
    status,
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 5,
    createdAt: 1,
    updatedAt: 2
  };
}

function createIoCapture(): {
  io: {
    stdout: { write: (chunk: string) => boolean };
    stderr: { write: (chunk: string) => boolean };
  };
  output: { stdout: string; stderr: string };
} {
  const output = { stdout: '', stderr: '' };

  return {
    io: {
      stdout: {
        write: (chunk: string): boolean => {
          output.stdout += chunk;
          return true;
        }
      },
      stderr: {
        write: (chunk: string): boolean => {
          output.stderr += chunk;
          return true;
        }
      }
    },
    output
  };
}

function createInstallSkillDependencies(options: {
  homeDir?: string;
  cwd?: string;
  existingPaths?: string[];
  skillContent?: string;
  skillNames?: string[];
} = {}): {
  dependencies: BuildProgramDependencies;
  mocks: {
    pathExists: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    listDirectory: ReturnType<typeof vi.fn>;
  };
} {
  const homeDir = options.homeDir ?? '/mock/home';
  const cwd = options.cwd ?? '/mock/workspace';
  const existingPaths = new Set(options.existingPaths ?? []);
  const skillContent = options.skillContent ?? '# mock skill';
  const skillNames = options.skillNames ?? ['dev-sessions'];
  const pathExists = vi.fn(async (candidatePath: string): Promise<boolean> => existingPaths.has(candidatePath));
  const mkdir = vi.fn().mockResolvedValue(undefined);
  const readFile = vi.fn().mockResolvedValue(skillContent);
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const listDirectory = vi.fn().mockResolvedValue(skillNames);

  return {
    dependencies: {
      installSkill: {
        skillsDirectory: () => '/mock/dev-sessions/skills',
        listDirectory,
        cwd: () => cwd,
        homedir: () => homeDir,
        pathExists,
        mkdir,
        readFile,
        writeFile
      }
    },
    mocks: {
      pathExists,
      mkdir,
      readFile,
      writeFile,
      listDirectory
    }
  };
}

describe('CLI argument parsing', () => {
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-cli-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses create options', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync([
      'node',
      'dev-sessions',
      'create',
      '--path',
      '/tmp/project',
      '--mode',
      'native',
      '--description',
      'backend task'
    ]);

    expect(manager.createSession).toHaveBeenCalledWith({
      path: '/tmp/project',
      cli: 'claude',
      mode: 'native',
      description: 'backend task'
    });
  });

  it('defaults create path to HOST_PATH when running in sandbox mode', async () => {
    const previousSandbox = process.env.DEV_SESSIONS_SANDBOX;
    const previousHostPath = process.env.HOST_PATH;
    process.env.DEV_SESSIONS_SANDBOX = '1';
    process.env.HOST_PATH = '/host/workspace';

    try {
      const manager = createManagerMock();
      const { io } = createIoCapture();
      const program = buildProgram(manager, io);

      await program.parseAsync(['node', 'dev-sessions', 'create']);

      expect(manager.createSession).toHaveBeenCalledWith({
        path: '/host/workspace',
        cli: 'claude',
        mode: 'native',
        description: undefined
      });
    } finally {
      if (previousSandbox === undefined) {
        delete process.env.DEV_SESSIONS_SANDBOX;
      } else {
        process.env.DEV_SESSIONS_SANDBOX = previousSandbox;
      }

      if (previousHostPath === undefined) {
        delete process.env.HOST_PATH;
      } else {
        process.env.HOST_PATH = previousHostPath;
      }
    }
  });

  it('supports create --quiet output', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'create', '--quiet']);

    expect(output.stdout.trim()).toBe('fizz-top');
  });

  it('parses create --cli codex', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'create', '--cli', 'codex']);

    expect(manager.createSession).toHaveBeenCalledWith({
      path: process.cwd(),
      cli: 'codex',
      mode: 'native',
      description: undefined
    });
  });

  it('parses send command with inline message', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'send', 'fizz-top', 'hello world']);

    expect(manager.sendMessage).toHaveBeenCalledWith('fizz-top', 'hello world');
  });

  it('parses send --file and reads file content', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const messageFile = path.join(tmpDir, 'briefing.md');
    await writeFile(messageFile, 'task from file', 'utf8');
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'send', 'fizz-top', '--file', messageFile]);

    expect(manager.sendMessage).toHaveBeenCalledWith('fizz-top', 'task from file');
  });

  it('supports list --json output', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);
    const sessions = [createMockSession('fizz-top')];

    await program.parseAsync(['node', 'dev-sessions', 'list', '--json']);

    expect(manager.listSessions).toHaveBeenCalledTimes(1);
    expect(output.stdout.trim()).toBe(JSON.stringify(sessions, null, 2));
  });

  it('parses last-message and wait options', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'last-message', 'fizz-top', '--count', '3']);
    expect(manager.getLastAssistantTextBlocks).toHaveBeenCalledWith('fizz-top', 3);

    await program.parseAsync(['node', 'dev-sessions', 'wait', 'fizz-top', '--timeout', '12', '--interval', '4']);
    expect(manager.waitForSession).toHaveBeenCalledWith('fizz-top', {
      timeoutSeconds: 12,
      intervalSeconds: 4
    });
  });

  it('parses ask command as send + wait + last-message', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'ask', 'fizz-top', 'what is 2+2?', '--timeout', '60']);

    expect(manager.sendMessage).toHaveBeenCalledWith('fizz-top', 'what is 2+2?');
    expect(manager.waitForSession).toHaveBeenCalledWith('fizz-top', { timeoutSeconds: 60 });
    expect(manager.getLastAssistantTextBlocks).toHaveBeenCalledWith('fizz-top', 1);
    expect(output.stdout).toBe('done\n');
  });

  it('ask exits 124 with a recovery hint when the wait times out', async () => {
    const manager = createManagerMock();
    (manager.waitForSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      completed: false,
      timedOut: true,
      elapsedMs: 60_000
    });
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await expect(
      program.parseAsync(['node', 'dev-sessions', 'ask', 'fizz-top', 'long task'])
    ).rejects.toMatchObject({ exitCode: 124 });
    expect(manager.getLastAssistantTextBlocks).not.toHaveBeenCalled();
  });

  it('parses goal set with budget and implies active status', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync([
      'node',
      'dev-sessions',
      'goal',
      'fizz-top',
      'refactor',
      'the',
      'parser',
      '--budget',
      '50000'
    ]);

    expect(manager.setSessionGoal).toHaveBeenCalledWith('fizz-top', {
      objective: 'refactor the parser',
      status: 'active',
      tokenBudget: 50_000
    });
  });

  it('parses a multiline dash-leading objective passed as one argument after --', async () => {
    // This is the argv shape the gateway produces: without the '--' terminator,
    // an objective starting with '-' is misparsed as an unknown option.
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    const objective = '- fix the parser\n- add regression tests\n- update TODO.md';
    await program.parseAsync(['node', 'dev-sessions', 'goal', 'fizz-top', '--json', '--', objective]);

    expect(manager.setSessionGoal).toHaveBeenCalledWith('fizz-top', {
      objective,
      status: 'active'
    });
  });

  it('parses a dash-leading message passed as one argument after --', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    const message = '- run the tests\n- report failures';
    await program.parseAsync(['node', 'dev-sessions', 'send', 'fizz-top', '--', message]);

    expect(manager.sendMessage).toHaveBeenCalledWith('fizz-top', message);
  });

  it('parses goal show, pause, resume, and clear', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'goal', 'fizz-top']);
    expect(manager.getSessionGoal).toHaveBeenCalledWith('fizz-top');
    expect(output.stdout).toContain('objective: ship the feature');
    expect(output.stdout).toContain('status: active');

    await program.parseAsync(['node', 'dev-sessions', 'goal', 'fizz-top', '--pause']);
    expect(manager.setSessionGoal).toHaveBeenCalledWith('fizz-top', { status: 'paused' });

    await program.parseAsync(['node', 'dev-sessions', 'goal', 'fizz-top', '--resume']);
    expect(manager.setSessionGoal).toHaveBeenCalledWith('fizz-top', { status: 'active' });

    await program.parseAsync(['node', 'dev-sessions', 'goal', 'fizz-top', '--clear']);
    expect(manager.clearSessionGoal).toHaveBeenCalledWith('fizz-top');
  });

  it('prints no-goal message when no goal is set', async () => {
    const manager = createManagerMock();
    (manager.getSessionGoal as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'goal', 'fizz-top']);
    expect(output.stdout).toBe('No goal set for fizz-top\n');
  });

  it('rejects conflicting goal flags', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await expect(
      program.parseAsync(['node', 'dev-sessions', 'goal', 'fizz-top', '--pause', '--clear'])
    ).rejects.toThrow('Use only one of --pause, --resume, --clear');

    await expect(
      program.parseAsync(['node', 'dev-sessions', 'goal', 'fizz-top', 'objective', '--clear'])
    ).rejects.toThrow('--clear cannot be combined');

    await expect(
      program.parseAsync(['node', 'dev-sessions', 'goal', 'fizz-top', 'objective', '--pause'])
    ).rejects.toThrow('--pause/--resume cannot be combined');
  });

  it('parses wait --goal and prints the terminal goal status', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'wait', 'fizz-top', '--goal', '--timeout', '30']);

    expect(manager.waitForSessionGoal).toHaveBeenCalledWith('fizz-top', {
      timeoutSeconds: 30,
      intervalSeconds: 2
    });
    expect(manager.waitForSession).not.toHaveBeenCalled();
    expect(output.stdout).toBe('complete\n');
  });

  it('wait --goal exits 124 on timeout', async () => {
    const manager = createManagerMock();
    (manager.waitForSessionGoal as ReturnType<typeof vi.fn>).mockResolvedValue({
      goal: createMockGoal('active'),
      timedOut: true,
      elapsedMs: 30_000
    });
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await expect(
      program.parseAsync(['node', 'dev-sessions', 'wait', 'fizz-top', '--goal'])
    ).rejects.toMatchObject({ exitCode: 124 });
  });

  it('parses wait --next-turn and rejects combining it with --goal', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'wait', 'fizz-top', '--next-turn', '--timeout', '60']);
    expect(manager.waitForSessionNextTurn).toHaveBeenCalledWith('fizz-top', { timeoutSeconds: 60 });
    expect(manager.waitForSession).not.toHaveBeenCalled();
    expect(output.stdout).toBe('completed\n');

    await expect(
      program.parseAsync(['node', 'dev-sessions', 'wait', 'fizz-top', '--next-turn', '--goal'])
    ).rejects.toThrow('Use only one of --goal, --next-turn');
  });

  it('wait --next-turn exits 124 on timeout', async () => {
    const manager = createManagerMock();
    (manager.waitForSessionNextTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      completed: false,
      timedOut: true,
      elapsedMs: 60_000
    });
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await expect(
      program.parseAsync(['node', 'dev-sessions', 'wait', 'fizz-top', '--next-turn'])
    ).rejects.toMatchObject({ exitCode: 124 });
  });

  it('outputs last-message blocks as JSON with --json', async () => {
    const manager = createManagerMock();
    (manager.getLastAssistantTextBlocks as ReturnType<typeof vi.fn>).mockResolvedValue([
      'one message with\n\na paragraph break',
      'second'
    ]);
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'last-message', 'fizz-top', '-n', '2', '--json']);
    expect(JSON.parse(output.stdout)).toEqual(['one message with\n\na paragraph break', 'second']);
  });

  it('kills all sessions with kill --all', async () => {
    const manager = createManagerMock();
    (manager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      createMockSession('fizz-top'),
      createMockSession('riven-jg')
    ]);
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'kill', '--all']);

    expect(manager.killSession).toHaveBeenCalledWith('fizz-top');
    expect(manager.killSession).toHaveBeenCalledWith('riven-jg');
    expect(output.stdout).toContain('Killed 2 sessions');
  });

  it('kills only stale sessions with kill --older-than', async () => {
    const manager = createManagerMock();
    const fresh = createMockSession('fizz-top');
    fresh.lastUsed = new Date().toISOString();
    const stale = createMockSession('riven-jg');
    stale.lastUsed = new Date(Date.now() - 8 * 86_400_000).toISOString();
    (manager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([fresh, stale]);
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'kill', '--older-than', '7d']);

    expect(manager.killSession).toHaveBeenCalledTimes(1);
    expect(manager.killSession).toHaveBeenCalledWith('riven-jg');
    expect(output.stdout).toContain('Killed 1 session');
  });

  it('rejects kill with no selector, multiple selectors, or bad durations', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await expect(program.parseAsync(['node', 'dev-sessions', 'kill'])).rejects.toThrow(
      'Provide exactly one of <id>, --all, or --older-than'
    );
    await expect(
      program.parseAsync(['node', 'dev-sessions', 'kill', 'fizz-top', '--all'])
    ).rejects.toThrow('Provide exactly one of <id>, --all, or --older-than');
    await expect(
      program.parseAsync(['node', 'dev-sessions', 'kill', '--older-than', 'tomorrow'])
    ).rejects.toThrow('--older-than must be a duration like 30m, 72h, or 7d');
    expect(manager.killSession).not.toHaveBeenCalled();
  });

  it('rejects non-integer numeric flags', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const program = buildProgram(manager, io);

    await expect(
      program.parseAsync(['node', 'dev-sessions', 'wait', 'fizz-top', '--timeout', '12s'])
    ).rejects.toThrow('--timeout must be a positive integer');
  });

  it('rejects install-skill when both --global and --local are provided', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const { dependencies } = createInstallSkillDependencies();
    const program = buildProgram(manager, io, dependencies);

    await expect(
      program.parseAsync(['node', 'dev-sessions', 'install-skill', '--global', '--local', '--claude'])
    ).rejects.toThrow('Cannot use both --global and --local');
  });

  it('installs skill globally for Claude when explicitly targeted', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const homeDir = '/home/test-user';
    const { dependencies, mocks } = createInstallSkillDependencies({ homeDir });
    const program = buildProgram(manager, io, dependencies);

    await program.parseAsync(['node', 'dev-sessions', 'install-skill', '--global', '--claude']);

    const expectedDir = path.join(homeDir, '.claude', 'skills', 'dev-sessions');
    const expectedFile = path.join(expectedDir, 'SKILL.md');
    expect(mocks.readFile).toHaveBeenCalledWith('/mock/dev-sessions/skills/dev-sessions/SKILL.md', 'utf8');
    expect(mocks.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
    expect(mocks.writeFile).toHaveBeenCalledWith(expectedFile, '# mock skill', 'utf8');
    expect(mocks.pathExists).not.toHaveBeenCalled();
  });

  it('installs skill locally for Codex when explicitly targeted', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const cwd = '/workspace/project';
    const { dependencies, mocks } = createInstallSkillDependencies({ cwd });
    const program = buildProgram(manager, io, dependencies);

    await program.parseAsync(['node', 'dev-sessions', 'install-skill', '--local', '--codex']);

    const expectedDir = path.join(cwd, '.codex', 'skills', 'dev-sessions');
    const expectedFile = path.join(expectedDir, 'SKILL.md');
    expect(mocks.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
    expect(mocks.writeFile).toHaveBeenCalledWith(expectedFile, '# mock skill', 'utf8');
  });

  it('auto-detects Claude when only ~/.claude exists', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const homeDir = '/home/autodetect';
    const claudePath = path.join(homeDir, '.claude');
    const { dependencies, mocks } = createInstallSkillDependencies({
      homeDir,
      existingPaths: [claudePath]
    });
    const program = buildProgram(manager, io, dependencies);

    await program.parseAsync(['node', 'dev-sessions', 'install-skill']);

    expect(mocks.pathExists).toHaveBeenCalledWith(path.join(homeDir, '.claude'));
    expect(mocks.pathExists).toHaveBeenCalledWith(path.join(homeDir, '.codex'));
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'skills', 'dev-sessions', 'SKILL.md'),
      '# mock skill',
      'utf8'
    );
  });

  it('auto-detects Codex when only ~/.codex exists', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const homeDir = '/home/autodetect';
    const codexPath = path.join(homeDir, '.codex');
    const { dependencies, mocks } = createInstallSkillDependencies({
      homeDir,
      existingPaths: [codexPath]
    });
    const program = buildProgram(manager, io, dependencies);

    await program.parseAsync(['node', 'dev-sessions', 'install-skill']);

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      path.join(homeDir, '.codex', 'skills', 'dev-sessions', 'SKILL.md'),
      '# mock skill',
      'utf8'
    );
  });

  it('auto-detects both tools when ~/.claude and ~/.codex both exist', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const homeDir = '/home/autodetect';
    const { dependencies, mocks } = createInstallSkillDependencies({
      homeDir,
      existingPaths: [path.join(homeDir, '.claude'), path.join(homeDir, '.codex')]
    });
    const program = buildProgram(manager, io, dependencies);

    await program.parseAsync(['node', 'dev-sessions', 'install-skill']);

    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'skills', 'dev-sessions', 'SKILL.md'),
      '# mock skill',
      'utf8'
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(
      path.join(homeDir, '.codex', 'skills', 'dev-sessions', 'SKILL.md'),
      '# mock skill',
      'utf8'
    );
  });

  it('defaults to Claude install when neither ~/.claude nor ~/.codex exists', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const homeDir = '/home/autodetect';
    const { dependencies, mocks } = createInstallSkillDependencies({ homeDir });
    const program = buildProgram(manager, io, dependencies);

    await program.parseAsync(['node', 'dev-sessions', 'install-skill']);

    expect(output.stdout).toContain('No ~/.claude or ~/.codex found; defaulting to Claude Code.');
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'skills', 'dev-sessions', 'SKILL.md'),
      '# mock skill',
      'utf8'
    );
  });

  it('installs all skills when multiple skill directories exist', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const homeDir = '/home/test-user';
    const { dependencies, mocks } = createInstallSkillDependencies({
      homeDir,
      skillNames: ['dev-sessions', 'handoff']
    });
    const program = buildProgram(manager, io, dependencies);

    await program.parseAsync(['node', 'dev-sessions', 'install-skill', '--global', '--claude']);

    expect(mocks.listDirectory).toHaveBeenCalledWith('/mock/dev-sessions/skills');
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'skills', 'dev-sessions', 'SKILL.md'),
      '# mock skill',
      'utf8'
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'skills', 'handoff', 'SKILL.md'),
      '# mock skill',
      'utf8'
    );
    expect(output.stdout).toContain('dev-sessions');
    expect(output.stdout).toContain('handoff');
  });

  it('logs command calls getSessionLogs and prints turns with role labels', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'logs', 'fizz-top']);

    expect(manager.getSessionLogs).toHaveBeenCalledWith('fizz-top');
    expect(output.stdout).toContain('[HUMAN]');
    expect(output.stdout).toContain('hello');
    expect(output.stdout).toContain('[ASSISTANT]');
    expect(output.stdout).toContain('world');
  });

  it('logs command prints no-history message when logs are empty', async () => {
    const manager = createManagerMock();
    (manager.getSessionLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'logs', 'fizz-top']);

    expect(output.stdout).toContain('No conversation history available');
  });

  it('inspect command calls inspectSession and prints JSON', async () => {
    const manager = createManagerMock();
    const { io, output } = createIoCapture();
    const program = buildProgram(manager, io);

    await program.parseAsync(['node', 'dev-sessions', 'inspect', 'fizz-top']);

    expect(manager.inspectSession).toHaveBeenCalledWith('fizz-top');
    const parsed = JSON.parse(output.stdout) as { championId: string };
    expect(parsed.championId).toBe('fizz-top');
  });

  it('installs all skills for all targets when multiple skills and targets exist', async () => {
    const manager = createManagerMock();
    const { io } = createIoCapture();
    const homeDir = '/home/test-user';
    const { dependencies, mocks } = createInstallSkillDependencies({
      homeDir,
      skillNames: ['dev-sessions', 'handoff']
    });
    const program = buildProgram(manager, io, dependencies);

    await program.parseAsync(['node', 'dev-sessions', 'install-skill', '--global', '--claude', '--codex']);

    // 2 skills × 2 targets = 4 writes
    expect(mocks.writeFile).toHaveBeenCalledTimes(4);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'skills', 'handoff', 'SKILL.md'),
      '# mock skill',
      'utf8'
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(
      path.join(homeDir, '.codex', 'skills', 'handoff', 'SKILL.md'),
      '# mock skill',
      'utf8'
    );
  });
});
