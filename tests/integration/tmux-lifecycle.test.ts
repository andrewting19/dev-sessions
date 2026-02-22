import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ClaudeTmuxBackend } from '../../src/backends/claude-tmux';
import {
  cleanupPrefixedTmuxSessions,
  DEV_TEST_TMUX_PREFIX,
  runTmux,
  TMUX_AVAILABLE,
  waitForCondition
} from './helpers';

const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

class TestSendKeysBackend extends ClaudeTmuxBackend {
  override async isClaudeRunning(): Promise<boolean> {
    return true;
  }
}

function createSessionName(suffix: string): string {
  return `${DEV_TEST_TMUX_PREFIX}${suffix}-${randomUUID().slice(0, 8)}`;
}

describeIfTmux('tmux lifecycle integration', () => {
  const backend = new ClaudeTmuxBackend();
  const sendKeysBackend = new TestSendKeysBackend();

  afterEach(async () => {
    await cleanupPrefixedTmuxSessions();
  });

  afterAll(async () => {
    await cleanupPrefixedTmuxSessions();
  });

  it(
    'creates and cleans up a tmux session',
    async () => {
      const sessionName = createSessionName('create');

      const createResult = await runTmux(['new-session', '-d', '-s', sessionName, '-n', sessionName, 'sleep 999']);
      expect(createResult.code).toBe(0);

      const hasSessionResult = await runTmux(['has-session', '-t', sessionName]);
      expect(hasSessionResult.code).toBe(0);

      const killResult = await runTmux(['kill-session', '-t', sessionName]);
      expect(killResult.code).toBe(0);

      const missingSessionResult = await runTmux(['has-session', '-t', sessionName]);
      expect(missingSessionResult.code).not.toBe(0);
    },
    20_000
  );

  it(
    'sends a base64-encoded command and captures pane output',
    async () => {
      const sessionName = createSessionName('sendkeys');
      const marker = `dev-test-marker-${randomUUID().slice(0, 8)}`;
      const command = `printf '%s\\n' "payload with '\''quotes'\'' ${marker}"`;

      const createResult = await runTmux(['new-session', '-d', '-s', sessionName, '-n', sessionName, 'bash']);
      expect(createResult.code).toBe(0);

      await sendKeysBackend.sendMessage(sessionName, command);

      const markerVisible = await waitForCondition(async () => {
        const captureResult = await runTmux(['capture-pane', '-p', '-t', sessionName], 5_000);
        return captureResult.code === 0 && captureResult.stdout.includes(marker);
      }, 10_000, 250);

      expect(markerVisible).toBe(true);
    },
    20_000
  );

  it(
    'returns true for existing sessions and false for missing sessions',
    async () => {
      const sessionName = createSessionName('exists');

      expect(await backend.sessionExists(sessionName)).toBe(false);

      const createResult = await runTmux(['new-session', '-d', '-s', sessionName, '-n', sessionName, 'sleep 999']);
      expect(createResult.code).toBe(0);

      expect(await backend.sessionExists(sessionName)).toBe(true);

      const killResult = await runTmux(['kill-session', '-t', sessionName]);
      expect(killResult.code).toBe(0);

      expect(await backend.sessionExists(sessionName)).toBe(false);
    },
    20_000
  );

  it(
    'detects a running CLI process on pane tty and updates after termination',
    async () => {
      const sessionName = createSessionName('running');

      const createResult = await runTmux(['new-session', '-d', '-s', sessionName, '-n', sessionName, 'bash']);
      expect(createResult.code).toBe(0);

      expect(await backend.isCliRunning(sessionName)).toBe(false);

      const sendResult = await runTmux(['send-keys', '-t', sessionName, 'sleep 999', 'C-m']);
      expect(sendResult.code).toBe(0);

      const becameRunning = await waitForCondition(() => backend.isCliRunning(sessionName), 10_000, 250);
      expect(becameRunning).toBe(true);

      const interruptResult = await runTmux(['send-keys', '-t', sessionName, 'C-c']);
      expect(interruptResult.code).toBe(0);

      const becameIdle = await waitForCondition(async () => !(await backend.isCliRunning(sessionName)), 10_000, 250);
      expect(becameIdle).toBe(true);
    },
    20_000
  );

});
