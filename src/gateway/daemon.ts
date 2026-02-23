import { execFile } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveGatewayCliBinary, resolveGatewayPort } from './server';

const execFileAsync = promisify(execFile);

export const LAUNCHD_LABEL = 'com.dev-sessions.gateway';
export const SYSTEMD_SERVICE_NAME = 'dev-sessions-gateway';

export function getLaunchdPlistPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function getSystemdUnitPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.config', 'systemd', 'user', `${SYSTEMD_SERVICE_NAME}.service`);
}

export function getGatewayLogPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.dev-sessions', 'gateway.log');
}

export function buildLaunchdPlist(binaryPath: string, port: number, logPath: string, nodePath?: string): string {
  // launchd runs with a minimal PATH that won't find NVM-managed node.
  // If nodePath is provided, invoke node explicitly so the shebang is bypassed.
  const programArgs = nodePath
    ? `    <string>${nodePath}</string>\n    <string>${binaryPath}</string>`
    : `    <string>${binaryPath}</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
    <string>gateway</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DEV_SESSIONS_GATEWAY_PORT</key>
    <string>${port}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

export function buildSystemdUnit(binaryPath: string, port: number, logPath: string, nodePath?: string): string {
  const execStart = nodePath
    ? `${nodePath} ${binaryPath} gateway --port ${port}`
    : `${binaryPath} gateway --port ${port}`;

  return `[Unit]
Description=dev-sessions gateway HTTP server
After=network.target

[Service]
ExecStart=${execStart}
Environment=DEV_SESSIONS_GATEWAY_PORT=${port}
Restart=on-failure
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

export async function installGatewayDaemon(options: {
  binaryPath?: string;
  port?: number;
  platform?: string;
  homeDir?: string;
  nodePath?: string;
} = {}): Promise<void> {
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const binaryPath = options.binaryPath ?? resolveGatewayCliBinary();
  const port = options.port ?? resolveGatewayPort();
  const logPath = getGatewayLogPath(homeDir);
  // Resolve node binary so launchd/systemd can find it regardless of PATH.
  const nodePath = options.nodePath ?? process.execPath;

  await mkdir(path.dirname(logPath), { recursive: true });

  if (platform === 'darwin') {
    const plistPath = getLaunchdPlistPath(homeDir);
    const plistContent = buildLaunchdPlist(binaryPath, port, logPath, nodePath);
    await mkdir(path.dirname(plistPath), { recursive: true });
    await writeFile(plistPath, plistContent, 'utf8');

    try {
      await execFileAsync('launchctl', ['unload', plistPath]);
    } catch {
      // Ignore: service may not have been loaded yet.
    }

    await execFileAsync('launchctl', ['load', plistPath]);
    console.log(`[gateway] daemon installed at ${plistPath}`);
    return;
  }

  if (platform === 'linux') {
    const unitPath = getSystemdUnitPath(homeDir);
    const unitContent = buildSystemdUnit(binaryPath, port, logPath, nodePath);
    await mkdir(path.dirname(unitPath), { recursive: true });
    await writeFile(unitPath, unitContent, 'utf8');
    await execFileAsync('systemctl', ['--user', 'daemon-reload']);
    await execFileAsync('systemctl', ['--user', 'enable', '--now', SYSTEMD_SERVICE_NAME]);
    console.log(`[gateway] daemon installed at ${unitPath}`);
    return;
  }

  throw new Error(
    `Unsupported platform: ${platform}. Gateway daemon install is supported on darwin and linux.`
  );
}

export async function uninstallGatewayDaemon(options: {
  platform?: string;
  homeDir?: string;
} = {}): Promise<void> {
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;

  if (platform === 'darwin') {
    const plistPath = getLaunchdPlistPath(homeDir);

    try {
      await execFileAsync('launchctl', ['unload', plistPath]);
    } catch {
      // Ignore: may not have been loaded.
    }

    try {
      await unlink(plistPath);
    } catch {
      // Ignore: may not exist.
    }

    console.log(`[gateway] daemon uninstalled (${plistPath})`);
    return;
  }

  if (platform === 'linux') {
    try {
      await execFileAsync('systemctl', ['--user', 'disable', '--now', SYSTEMD_SERVICE_NAME]);
    } catch {
      // Ignore: may not be active.
    }

    const unitPath = getSystemdUnitPath(homeDir);

    try {
      await unlink(unitPath);
    } catch {
      // Ignore: may not exist.
    }

    try {
      await execFileAsync('systemctl', ['--user', 'daemon-reload']);
    } catch {
      // Best effort.
    }

    console.log(`[gateway] daemon uninstalled (${unitPath})`);
    return;
  }

  throw new Error(
    `Unsupported platform: ${platform}. Gateway daemon uninstall is supported on darwin and linux.`
  );
}

export async function getGatewayDaemonStatus(options: {
  platform?: string;
  port?: number;
} = {}): Promise<{ running: boolean; port: number }> {
  const platform = options.platform ?? process.platform;
  const port = options.port ?? resolveGatewayPort();

  if (platform === 'darwin') {
    try {
      // launchctl list <label> exits 0 when the job is loaded, non-zero otherwise.
      await execFileAsync('launchctl', ['list', LAUNCHD_LABEL]);
      return { running: true, port };
    } catch {
      return { running: false, port };
    }
  }

  if (platform === 'linux') {
    try {
      await execFileAsync('systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_SERVICE_NAME]);
      return { running: true, port };
    } catch {
      return { running: false, port };
    }
  }

  throw new Error(
    `Unsupported platform: ${platform}. Gateway daemon status is supported on darwin and linux.`
  );
}
