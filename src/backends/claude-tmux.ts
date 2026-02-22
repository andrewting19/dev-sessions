import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { SessionMode } from '../types';

const execFileAsync = promisify(execFile);

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class ClaudeTmuxBackend {
  constructor(private readonly timeoutMs: number = 15_000) {}

  async createSession(
    tmuxSessionName: string,
    workspacePath: string,
    mode: SessionMode,
    sessionUuid: string
  ): Promise<void> {
    const startupCommand = this.buildStartupCommand(workspacePath, mode, sessionUuid);

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
      `tmux send-keys -l -t ${sessionTarget} "$decoded"`,
      `tmux send-keys -t ${sessionTarget} C-m`,
      `tmux send-keys -t ${sessionTarget} C-m`
    ].join('\n');

    await this.execCommand('bash', ['-lc', script], 30_000);
  }

  async killSession(tmuxSessionName: string): Promise<void> {
    await this.execTmux(['kill-session', '-t', tmuxSessionName]);
  }

  async listSessions(): Promise<string[]> {
    try {
      const output = await this.execTmux(['list-sessions', '-F', '#{session_name}']);
      return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  async sessionExists(tmuxSessionName: string): Promise<boolean> {
    try {
      await this.execTmux(['has-session', '-t', tmuxSessionName]);
      return true;
    } catch {
      return false;
    }
  }

  async isClaudeRunning(tmuxSessionName: string): Promise<boolean> {
    try {
      const paneOutput = await this.execTmux(['list-panes', '-t', tmuxSessionName, '-F', '#{pane_tty}']);
      const paneTtys = paneOutput
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const paneTty of paneTtys) {
        const ttyName = path.basename(paneTty);

        let psOutput = '';
        try {
          psOutput = await this.execCommand('ps', ['-t', ttyName, '-o', 'command=']);
        } catch {
          continue;
        }

        if (
          /(^|\s|\/)(claude|clauded)(\s|$)/.test(psOutput) ||
          /docker.*ubuntu-dev/.test(psOutput)
        ) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private buildStartupCommand(workspacePath: string, mode: SessionMode, sessionUuid: string): string {
    const binary = mode === 'docker' ? 'clauded' : 'claude';
    const commandParts = [`${binary} --session-id ${shellEscape(sessionUuid)}`];

    if (mode === 'yolo') {
      commandParts.push('--dangerously-skip-permissions');
    }

    return `cd ${shellEscape(workspacePath)} && ${commandParts.join(' ')}`;
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
