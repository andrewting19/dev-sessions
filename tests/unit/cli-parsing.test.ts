import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, SessionManagerLike } from '../../src/cli';
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
});
