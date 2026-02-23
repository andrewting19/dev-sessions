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
    mode: 'yolo',
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
    waitForSession: vi.fn().mockResolvedValue({ completed: true, timedOut: false, elapsedMs: 1000 })
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
    const previousSandbox = process.env.IS_SANDBOX;
    const previousHostPath = process.env.HOST_PATH;
    process.env.IS_SANDBOX = '1';
    process.env.HOST_PATH = '/host/workspace';

    try {
      const manager = createManagerMock();
      const { io } = createIoCapture();
      const program = buildProgram(manager, io);

      await program.parseAsync(['node', 'dev-sessions', 'create']);

      expect(manager.createSession).toHaveBeenCalledWith({
        path: '/host/workspace',
        cli: 'claude',
        mode: 'yolo',
        description: undefined
      });
    } finally {
      if (previousSandbox === undefined) {
        delete process.env.IS_SANDBOX;
      } else {
        process.env.IS_SANDBOX = previousSandbox;
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
      mode: 'yolo',
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
