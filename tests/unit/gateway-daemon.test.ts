import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LAUNCHD_LABEL,
  SYSTEMD_SERVICE_NAME,
  buildLaunchdPlist,
  buildSystemdUnit,
  getGatewayDaemonStatus,
  getGatewayLogPath,
  getLaunchdPlistPath,
  getSystemdUnitPath,
  installGatewayDaemon
} from '../../src/gateway/daemon';

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}));

describe('gateway daemon template helpers', () => {
  it('enables Linux user lingering before it starts the gateway service', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'dev-sessions-daemon-'));
    const calls: Array<{ command: string; args: string[] }> = [];
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation((command, args, callback: any) => {
      calls.push({ command: String(command), args: [...(args ?? [])].map(String) });
      callback(null, '', '');
      return {} as any;
    });
    try {
      await installGatewayDaemon({
        platform: 'linux',
        homeDir: temp,
        binaryPath: '/usr/local/bin/dev-sessions',
        nodePath: '/usr/local/bin/node',
        userPath: '/usr/local/bin:/usr/bin'
      });
      const linger = calls.findIndex((call) => call.command === 'loginctl');
      const enable = calls.findIndex((call) => call.command === 'systemctl' && call.args.includes('enable'));
      expect(calls[linger]).toMatchObject({ args: ['enable-linger'] });
      expect(linger).toBeLessThan(enable);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  describe('getLaunchdPlistPath', () => {
    it('returns path under Library/LaunchAgents with the correct label', () => {
      const result = getLaunchdPlistPath('/Users/test');
      expect(result).toBe(
        `/Users/test/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`
      );
    });
  });

  describe('getSystemdUnitPath', () => {
    it('returns path under .config/systemd/user with the correct service name', () => {
      const result = getSystemdUnitPath('/home/test');
      expect(result).toBe(
        `/home/test/.config/systemd/user/${SYSTEMD_SERVICE_NAME}.service`
      );
    });
  });

  describe('getGatewayLogPath', () => {
    it('returns path under .dev-sessions/gateway.log', () => {
      const result = getGatewayLogPath('/Users/test');
      expect(result).toBe('/Users/test/.dev-sessions/gateway.log');
    });
  });

  describe('buildLaunchdPlist', () => {
    const binaryPath = '/usr/local/bin/dev-sessions';
    const port = 6767;
    const logPath = '/Users/test/.dev-sessions/gateway.log';

    it('includes the launchd label', () => {
      const plist = buildLaunchdPlist(binaryPath, port, logPath);
      expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    });

    it('includes the binary path in ProgramArguments', () => {
      const plist = buildLaunchdPlist(binaryPath, port, logPath);
      expect(plist).toContain(`<string>${binaryPath}</string>`);
      expect(plist).toContain('<string>gateway</string>');
      expect(plist).toContain('<string>--port</string>');
      expect(plist).toContain(`<string>${port}</string>`);
    });

    it('sets DEV_SESSIONS_GATEWAY_PORT environment variable', () => {
      const plist = buildLaunchdPlist(binaryPath, port, logPath);
      expect(plist).toContain('<key>DEV_SESSIONS_GATEWAY_PORT</key>');
      expect(plist).toContain(`<string>${port}</string>`);
    });

    it('sets KeepAlive to true', () => {
      const plist = buildLaunchdPlist(binaryPath, port, logPath);
      expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    });

    it('sets StandardOutPath and StandardErrorPath to logPath', () => {
      const plist = buildLaunchdPlist(binaryPath, port, logPath);
      expect(plist).toContain(`<string>${logPath}</string>`);
      expect(plist).toContain('<key>StandardOutPath</key>');
      expect(plist).toContain('<key>StandardErrorPath</key>');
    });

    it('is valid XML structure (has plist root and dict)', () => {
      const plist = buildLaunchdPlist(binaryPath, port, logPath);
      expect(plist).toContain('<?xml version="1.0"');
      expect(plist).toContain('<plist version="1.0">');
      expect(plist).toContain('<dict>');
      expect(plist).toContain('</dict>');
      expect(plist).toContain('</plist>');
    });

    it('embeds a custom port correctly', () => {
      const plist = buildLaunchdPlist(binaryPath, 9999, logPath);
      expect(plist).toContain('<string>9999</string>');
    });
  });

  describe('getGatewayDaemonStatus', () => {
    it('returns running=true on darwin when launchctl exits 0', async () => {
      const { execFile } = await import('node:child_process');
      const mockedExecFile = vi.mocked(execFile);
      mockedExecFile.mockImplementation((_cmd, _args, cb: any) => {
        cb(null, '', '');
        return {} as any;
      });
      const result = await getGatewayDaemonStatus({ platform: 'darwin', port: 6767 });
      expect(result).toEqual({ running: true, port: 6767 });
    });

    it('returns running=false on darwin when launchctl exits non-zero', async () => {
      const { execFile } = await import('node:child_process');
      const mockedExecFile = vi.mocked(execFile);
      mockedExecFile.mockImplementation((_cmd, _args, cb: any) => {
        cb(new Error('not found'), '', '');
        return {} as any;
      });
      const result = await getGatewayDaemonStatus({ platform: 'darwin', port: 6767 });
      expect(result).toEqual({ running: false, port: 6767 });
    });

    it('returns running=true on linux when systemctl is-active exits 0', async () => {
      const { execFile } = await import('node:child_process');
      const mockedExecFile = vi.mocked(execFile);
      mockedExecFile.mockImplementation((_cmd, _args, cb: any) => {
        cb(null, '', '');
        return {} as any;
      });
      const result = await getGatewayDaemonStatus({ platform: 'linux', port: 6767 });
      expect(result).toEqual({ running: true, port: 6767 });
    });

    it('returns running=false on linux when systemctl is-active exits non-zero', async () => {
      const { execFile } = await import('node:child_process');
      const mockedExecFile = vi.mocked(execFile);
      mockedExecFile.mockImplementation((_cmd, _args, cb: any) => {
        cb(new Error('inactive'), '', '');
        return {} as any;
      });
      const result = await getGatewayDaemonStatus({ platform: 'linux', port: 6767 });
      expect(result).toEqual({ running: false, port: 6767 });
    });

    it('throws on unsupported platform', async () => {
      await expect(getGatewayDaemonStatus({ platform: 'win32', port: 6767 })).rejects.toThrow(
        'Unsupported platform'
      );
    });
  });

  describe('buildSystemdUnit', () => {
    const binaryPath = '/usr/local/bin/dev-sessions';
    const port = 6767;
    const logPath = '/home/test/.dev-sessions/gateway.log';

    it('includes the ExecStart line with binary path, gateway subcommand, and port', () => {
      const unit = buildSystemdUnit(binaryPath, port, logPath);
      expect(unit).toContain(
        `ExecStart=${binaryPath} gateway --port ${port}`
      );
    });

    it('sets DEV_SESSIONS_GATEWAY_PORT environment variable', () => {
      const unit = buildSystemdUnit(binaryPath, port, logPath);
      expect(unit).toContain(`Environment=DEV_SESSIONS_GATEWAY_PORT=${port}`);
    });

    it('sets Restart=on-failure', () => {
      const unit = buildSystemdUnit(binaryPath, port, logPath);
      expect(unit).toContain('Restart=on-failure');
    });

    it('appends stdout and stderr to logPath', () => {
      const unit = buildSystemdUnit(binaryPath, port, logPath);
      expect(unit).toContain(`StandardOutput=append:${logPath}`);
      expect(unit).toContain(`StandardError=append:${logPath}`);
    });

    it('includes [Unit], [Service], and [Install] sections', () => {
      const unit = buildSystemdUnit(binaryPath, port, logPath);
      expect(unit).toContain('[Unit]');
      expect(unit).toContain('[Service]');
      expect(unit).toContain('[Install]');
    });

    it('sets WantedBy=default.target', () => {
      const unit = buildSystemdUnit(binaryPath, port, logPath);
      expect(unit).toContain('WantedBy=default.target');
    });

    it('embeds a custom port correctly', () => {
      const unit = buildSystemdUnit(binaryPath, 9999, logPath);
      expect(unit).toContain('--port 9999');
      expect(unit).toContain('DEV_SESSIONS_GATEWAY_PORT=9999');
    });
  });
});
