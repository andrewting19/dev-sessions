import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getClaudeTranscriptPath } from '../transcript/claude-parser';
import { SessionMode } from '../types';

const execFileAsync = promisify(execFile);
const SHELL_COMMAND_PATTERN = /(^|\s|\/)-?(bash|zsh|sh|fish)(\s|$)/;
const CONTROL_COMMAND_PATTERN = /(^|\s|\/)(tmux|login)(\s|$)/;

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class ClaudeTmuxBackend {
  constructor(
    private readonly timeoutMs: number = 60_000,
    private readonly readyStabilityMs: number = 750
  ) {}

  async createSession(
    tmuxSessionName: string,
    workspacePath: string,
    mode: SessionMode,
    sessionUuid: string
  ): Promise<void> {
    await this.startSession(tmuxSessionName, workspacePath, mode, sessionUuid, false);
  }

  async resumeSession(
    tmuxSessionName: string,
    workspacePath: string,
    mode: SessionMode,
    sessionUuid: string
  ): Promise<void> {
    await this.startSession(tmuxSessionName, workspacePath, mode, sessionUuid, true);
  }

  private async startSession(
    tmuxSessionName: string,
    workspacePath: string,
    mode: SessionMode,
    sessionUuid: string,
    resume: boolean
  ): Promise<void> {
    if (mode === 'docker') {
      try {
        await this.execCommand('which', ['clauded'], 5000);
      } catch {
        throw new Error(
          '`clauded` not found. docker mode requires a clauded binary that wraps `docker run ... claude`. ' +
          'See https://github.com/anthropics/claude-ting for a reference implementation.'
        );
      }
    }

    const startupCommand = this.buildStartupCommand(workspacePath, mode, sessionUuid, resume);

    await this.execTmux([
      'new-session',
      '-d',
      '-s',
      tmuxSessionName,
      '-n',
      tmuxSessionName,
      'bash',
      '-lc',
      startupCommand
    ]);

    if (mode === 'docker') {
      await this.sleep(5000);
      await this.execTmux(['send-keys', '-t', tmuxSessionName, 'C-m']);
    } else {
      try {
        await this.waitForInteractiveReady(tmuxSessionName, workspacePath, sessionUuid);
      } catch (error: unknown) {
        await this.killSession(tmuxSessionName).catch(() => undefined);
        throw error;
      }
    }
  }

  async sendMessage(tmuxSessionName: string, message: string): Promise<void> {
    if (!(await this.isClaudeRunning(tmuxSessionName))) {
      throw new Error('Claude is not running in this tmux session - refusing to send message');
    }

    const encodedMessage = Buffer.from(message, 'utf8').toString('base64');
    const sessionTarget = shellEscape(tmuxSessionName);
    const encoded = shellEscape(encodedMessage);

    const script = [
      `decoded=$( (printf '%s' ${encoded} | base64 --decode 2>/dev/null) || (printf '%s' ${encoded} | base64 -D) )`,
      `tmux send-keys -l -t ${sessionTarget} "$decoded"`
    ].join('\n');

    await this.execCommand('bash', ['-lc', script], 30_000);

    // Small gaps mirror the original SSH gateway timing and improve submit reliability.
    await this.sleep(75);

    // Keep Enter presses as separate tmux commands to match the original gateway behavior.
    await this.execTmux(['send-keys', '-t', tmuxSessionName, 'C-m']);
    await this.sleep(150);
    await this.execTmux(['send-keys', '-t', tmuxSessionName, 'C-m']);
  }

  async submitMessage(tmuxSessionName: string): Promise<void> {
    await this.execTmux(['send-keys', '-t', tmuxSessionName, 'C-m']);
  }

  async killSession(tmuxSessionName: string): Promise<void> {
    await this.execTmux(['kill-session', '-t', tmuxSessionName]);
  }

  async sessionExists(tmuxSessionName: string): Promise<'alive' | 'dead' | 'unknown'> {
    try {
      await this.execTmux(['has-session', '-t', tmuxSessionName]);
      return 'alive';
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        // "no server running" is definitive: without a tmux server there are no
        // sessions, so the target session cannot be alive.
        /can't find session|session not found|no server running/i.test(error.message)
      ) {
        return 'dead';
      }
      return 'unknown';
    }
  }

  async isClaudeRunning(tmuxSessionName: string): Promise<boolean> {
    return this.isCliRunning(tmuxSessionName, [
      /(^|\s|\/)(claude|clauded)(\s|$)/,
      /docker.*ubuntu-dev/
    ]);
  }

  async isCliRunning(tmuxSessionName: string, commandPatterns: RegExp[] = []): Promise<boolean> {
    try {
      const paneCommands = await this.getPaneCommands(tmuxSessionName);

      if (commandPatterns.length > 0) {
        return paneCommands.some((command) =>
          commandPatterns.some((pattern) => pattern.test(command))
        );
      }

      return paneCommands.some((command) => this.isUserCliProcess(command));
    } catch {
      return false;
    }
  }

  private async getPaneCommands(tmuxSessionName: string): Promise<string[]> {
    const paneOutput = await this.execTmux(['list-panes', '-t', tmuxSessionName, '-F', '#{pane_tty}']);
    const paneTtys = paneOutput
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const commands: string[] = [];

    for (const paneTty of paneTtys) {
      const ttyName = path.basename(paneTty);

      let psOutput = '';
      try {
        psOutput = await this.execCommand('ps', ['-t', ttyName, '-o', 'command=']);
      } catch {
        continue;
      }

      const ttyCommands = psOutput
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      commands.push(...ttyCommands);
    }

    return commands;
  }

  private isUserCliProcess(command: string): boolean {
    if (command.length === 0) {
      return false;
    }

    return !SHELL_COMMAND_PATTERN.test(command) && !CONTROL_COMMAND_PATTERN.test(command);
  }

  private buildStartupCommand(
    workspacePath: string,
    mode: SessionMode,
    sessionUuid: string,
    resume: boolean = false
  ): string {
    const binary = mode === 'docker' ? 'clauded' : 'claude';
    const sessionFlag = resume ? '--resume' : '--session-id';
    const commandParts = [`${binary} ${sessionFlag} ${shellEscape(sessionUuid)}`];

    if (mode === 'native') {
      commandParts.push('--dangerously-skip-permissions');
    }

    return `unset CLAUDECODE; export IS_SANDBOX=1; cd ${shellEscape(workspacePath)} && ${commandParts.join(' ')}`;
  }

  private async waitForInteractiveReady(
    tmuxSessionName: string,
    workspacePath: string,
    sessionUuid: string,
    pollIntervalMs: number = 200
  ): Promise<void> {
    const transcriptPath = getClaudeTranscriptPath(workspacePath, sessionUuid);
    const timeoutOverride = parseInt(process.env['DEV_SESSIONS_TRANSCRIPT_TIMEOUT_MS'] ?? '');
    const timeoutMs = Number.isFinite(timeoutOverride) && timeoutOverride >= 0 ? timeoutOverride : this.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    let promptReadySince: number | undefined;
    let trustConfirmed = false;
    let trustPromptReadySince: number | undefined;
    let lastPane = '';

    while (Date.now() < deadline) {
      try {
        await access(transcriptPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      try {
        const pane = await this.execTmux(['capture-pane', '-p', '-t', tmuxSessionName]);
        lastPane = pane;
        if (
          !trustConfirmed &&
          /Yes, I trust this folder/i.test(pane)
        ) {
          trustPromptReadySince ??= Date.now();
          if (Date.now() - trustPromptReadySince >= this.readyStabilityMs) {
            if (/❯\s*No, exit/i.test(pane)) {
              await this.execTmux(['send-keys', '-t', tmuxSessionName, 'Down']);
              await this.sleep(250);
            }
            await this.execTmux(['send-keys', '-t', tmuxSessionName, 'C-m']);
            trustConfirmed = true;
            trustPromptReadySince = undefined;
            promptReadySince = undefined;
          }
        } else if (
          /(?:^|\n)\s*❯(?:\s|$)/m.test(pane) &&
          /bypass permissions on/i.test(pane)
        ) {
          promptReadySince ??= Date.now();
          if (Date.now() - promptReadySince >= this.readyStabilityMs) {
            return;
          }
        } else {
          promptReadySince = undefined;
          trustPromptReadySince = undefined;
        }
      } catch (error: unknown) {
        const liveness = await this.sessionExists(tmuxSessionName);
        if (liveness === 'dead') {
          const paneDetail = lastPane.trim().slice(-1_000);
          throw new Error(
            'Claude exited before its interactive prompt became ready' +
            (paneDetail ? `\nLast tmux pane:\n${paneDetail}` : '')
          );
        }
      }

      await this.sleep(pollIntervalMs);
    }

    const paneDetail = lastPane.trim().slice(-1_000);
    throw new Error(
      `Timed out waiting for Claude to become ready in ${tmuxSessionName}. ` +
      `No interactive prompt appeared. Transcript: ${transcriptPath}` +
      (paneDetail ? `\nLast tmux pane:\n${paneDetail}` : '')
    );
  }

  private async execTmux(args: string[]): Promise<string> {
    return this.execCommand('tmux', args);
  }

  private async execCommand(command: string, args: string[], timeoutMs: number = this.timeoutMs): Promise<string> {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 4
    });

    return stdout;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
