import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
import express, { Request, Response } from 'express';
import { SessionCli, SessionMode, StoredSession } from '../types';

const execFileAsync = promisify(execFile);
const DEFAULT_GATEWAY_PORT = 6767;
const DEFAULT_GATEWAY_CLI_BINARY = 'dev-sessions';

const ALLOWED_CLIS: SessionCli[] = ['claude', 'codex'];
const ALLOWED_MODES: SessionMode[] = ['yolo', 'native', 'docker'];

export interface GatewayCommandResult {
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GatewayCommandExecutor = (args: string[]) => Promise<GatewayCommandResult>;

export interface StartGatewayServerOptions {
  port?: number;
  cliBinary?: string;
  executeCommand?: GatewayCommandExecutor;
}

export class GatewayCommandError extends Error {
  constructor(
    message: string,
    public readonly result: GatewayCommandResult
  ) {
    super(message);
    this.name = 'GatewayCommandError';
  }
}

interface CreateBody {
  path?: unknown;
  cli?: unknown;
  mode?: unknown;
  description?: unknown;
}

interface SendBody {
  sessionId?: unknown;
  message?: unknown;
  file?: unknown;
}

interface KillBody {
  sessionId?: unknown;
}

function ensureNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required and must be a non-empty string`);
  }

  return value;
}

function parsePositiveInteger(value: string, fieldName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function parsePositiveIntegerQuery(value: unknown, defaultValue: number, fieldName: string): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return parsePositiveInteger(value, fieldName);
}

function isGatewayCommandError(error: unknown): error is GatewayCommandError {
  return error instanceof GatewayCommandError;
}

function parseSessionsPayload(stdout: string): StoredSession[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Expected list command to return a JSON array');
  }

  return parsed as StoredSession[];
}

function serializeCommandResult(result: GatewayCommandResult): GatewayCommandResult {
  return {
    command: [...result.command],
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}

function jsonError(res: Response, statusCode: number, message: string): void {
  res.status(statusCode).json({
    ok: false,
    error: message
  });
}

function handleRouteError(res: Response, error: unknown): void {
  if (isGatewayCommandError(error)) {
    res.status(500).json({
      ok: false,
      error: error.message,
      output: serializeCommandResult(error.result)
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  jsonError(res, 500, message);
}

export function resolveGatewayPort(env: NodeJS.ProcessEnv = process.env): number {
  const rawPort = env.DEV_SESSIONS_GATEWAY_PORT;
  if (!rawPort) {
    return DEFAULT_GATEWAY_PORT;
  }

  try {
    return parsePositiveInteger(rawPort, 'DEV_SESSIONS_GATEWAY_PORT');
  } catch {
    return DEFAULT_GATEWAY_PORT;
  }
}

export function createGatewayCommandExecutor(
  cliBinary: string = DEFAULT_GATEWAY_CLI_BINARY
): GatewayCommandExecutor {
  return async (args: string[]): Promise<GatewayCommandResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(cliBinary, args, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 4,
        env: {
          ...process.env,
          IS_SANDBOX: '0',
          DEV_SESSIONS_GATEWAY_URL: ''
        }
      });

      return {
        command: [cliBinary, ...args],
        stdout,
        stderr,
        exitCode: 0
      };
    } catch (error: unknown) {
      const candidate = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      const exitCode =
        typeof candidate.code === 'number'
          ? candidate.code
          : candidate.code === 'ENOENT'
            ? 127
            : 1;
      const stderr = typeof candidate.stderr === 'string' && candidate.stderr.length > 0
        ? candidate.stderr
        : candidate.message;

      throw new GatewayCommandError(`Command failed: ${cliBinary} ${args.join(' ')}`.trim(), {
        command: [cliBinary, ...args],
        stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
        stderr,
        exitCode
      });
    }
  };
}

export function createGatewayApp(
  executeCommand: GatewayCommandExecutor = createGatewayCommandExecutor()
): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/create', async (req: Request<{}, unknown, CreateBody>, res: Response) => {
    try {
      const workspacePath = ensureNonEmptyString(req.body.path, 'path');
      const args = ['create', '--quiet', '--path', workspacePath];

      if (req.body.cli !== undefined) {
        if (typeof req.body.cli !== 'string' || !ALLOWED_CLIS.includes(req.body.cli as SessionCli)) {
          jsonError(res, 400, 'cli must be one of: claude, codex');
          return;
        }
        args.push('--cli', req.body.cli);
      }

      if (req.body.mode !== undefined) {
        if (typeof req.body.mode !== 'string' || !ALLOWED_MODES.includes(req.body.mode as SessionMode)) {
          jsonError(res, 400, 'mode must be one of: yolo, native, docker');
          return;
        }
        args.push('--mode', req.body.mode);
      }

      if (req.body.description !== undefined) {
        if (typeof req.body.description !== 'string') {
          jsonError(res, 400, 'description must be a string');
          return;
        }

        if (req.body.description.trim().length > 0) {
          args.push('--description', req.body.description);
        }
      }

      const createResult = await executeCommand(args);
      const sessionId = createResult.stdout.trim();
      if (sessionId.length === 0) {
        throw new Error('create command did not return a session ID');
      }

      let session: StoredSession | undefined;
      try {
        const listResult = await executeCommand(['list', '--json']);
        const sessions = parseSessionsPayload(listResult.stdout);
        session = sessions.find((candidate) => candidate.championId === sessionId);
      } catch {
        // create already succeeded; session lookup is best-effort
      }

      res.json({
        ok: true,
        sessionId,
        session,
        output: serializeCommandResult(createResult)
      });
    } catch (error: unknown) {
      if (error instanceof Error && /required and must be a non-empty string/.test(error.message)) {
        jsonError(res, 400, error.message);
        return;
      }

      handleRouteError(res, error);
    }
  });

  app.post('/send', async (req: Request<{}, unknown, SendBody>, res: Response) => {
    try {
      const sessionId = ensureNonEmptyString(req.body.sessionId, 'sessionId');
      const message =
        typeof req.body.message === 'string' && req.body.message.trim().length > 0 ? req.body.message : undefined;
      const file = typeof req.body.file === 'string' && req.body.file.trim().length > 0 ? req.body.file : undefined;

      if ((message && file) || (!message && !file)) {
        jsonError(res, 400, 'Provide exactly one of message or file');
        return;
      }

      const args = ['send', sessionId];
      if (file) {
        args.push('--file', file);
      } else if (message) {
        args.push(message);
      }

      const result = await executeCommand(args);
      res.json({
        ok: true,
        output: serializeCommandResult(result)
      });
    } catch (error: unknown) {
      if (error instanceof Error && /required and must be a non-empty string/.test(error.message)) {
        jsonError(res, 400, error.message);
        return;
      }

      handleRouteError(res, error);
    }
  });

  app.post('/kill', async (req: Request<{}, unknown, KillBody>, res: Response) => {
    try {
      const sessionId = ensureNonEmptyString(req.body.sessionId, 'sessionId');
      const result = await executeCommand(['kill', sessionId]);
      res.json({
        ok: true,
        output: serializeCommandResult(result)
      });
    } catch (error: unknown) {
      if (error instanceof Error && /required and must be a non-empty string/.test(error.message)) {
        jsonError(res, 400, error.message);
        return;
      }

      handleRouteError(res, error);
    }
  });

  app.get('/list', async (_req: Request, res: Response) => {
    try {
      const result = await executeCommand(['list', '--json']);
      const sessions = parseSessionsPayload(result.stdout);
      res.json({
        ok: true,
        sessions,
        output: serializeCommandResult(result)
      });
    } catch (error: unknown) {
      handleRouteError(res, error);
    }
  });

  app.get('/status', async (req: Request, res: Response) => {
    try {
      const sessionId = ensureNonEmptyString(req.query.id, 'id');
      const result = await executeCommand(['status', sessionId]);
      const status = result.stdout.trim();
      res.json({
        ok: true,
        status,
        output: serializeCommandResult(result)
      });
    } catch (error: unknown) {
      if (error instanceof Error && /required and must be a non-empty string/.test(error.message)) {
        jsonError(res, 400, error.message);
        return;
      }

      handleRouteError(res, error);
    }
  });

  app.get('/wait', async (req: Request, res: Response) => {
    let timeoutSeconds = 300;
    let intervalSeconds: number | undefined;
    try {
      const sessionId = ensureNonEmptyString(req.query.id, 'id');
      timeoutSeconds = parsePositiveIntegerQuery(req.query.timeout, 300, 'timeout');
      if (req.query.interval !== undefined) {
        intervalSeconds = parsePositiveIntegerQuery(req.query.interval, 2, 'interval');
      }

      const args = ['wait', sessionId, '--timeout', String(timeoutSeconds)];
      if (intervalSeconds !== undefined) {
        args.push('--interval', String(intervalSeconds));
      }

      const startTime = Date.now();
      try {
        const result = await executeCommand(args);
        res.json({
          ok: true,
          waitResult: {
            completed: true,
            timedOut: false,
            elapsedMs: Date.now() - startTime
          },
          output: serializeCommandResult(result)
        });
      } catch (error: unknown) {
        if (isGatewayCommandError(error) && error.result.exitCode === 124) {
          res.json({
            ok: true,
            waitResult: {
              completed: false,
              timedOut: true,
              elapsedMs: Date.now() - startTime
            },
            output: serializeCommandResult(error.result)
          });
          return;
        }

        throw error;
      }
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (/required and must be a non-empty string/.test(error.message) || /must be a positive integer/.test(error.message))
      ) {
        jsonError(res, 400, error.message);
        return;
      }

      handleRouteError(res, error);
    }
  });

  app.get('/last-message', async (req: Request, res: Response) => {
    try {
      const sessionId = ensureNonEmptyString(req.query.id, 'id');
      const count = parsePositiveIntegerQuery(req.query.n, 1, 'n');
      const result = await executeCommand(['last-message', sessionId, '-n', String(count)]);
      const trimmed = result.stdout.trim();
      const blocks = trimmed.length > 0
        ? trimmed.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block.length > 0)
        : [];

      res.json({
        ok: true,
        blocks,
        output: serializeCommandResult(result)
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (/required and must be a non-empty string/.test(error.message) || /must be a positive integer/.test(error.message))
      ) {
        jsonError(res, 400, error.message);
        return;
      }

      handleRouteError(res, error);
    }
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy'
    });
  });

  return app;
}

export async function startGatewayServer(options: StartGatewayServerOptions = {}): Promise<{
  app: express.Express;
  server: Server;
  port: number;
}> {
  const port = options.port ?? resolveGatewayPort();
  const executeCommand = options.executeCommand ?? createGatewayCommandExecutor(options.cliBinary);
  const app = createGatewayApp(executeCommand);

  const server = await new Promise<Server>((resolve, reject) => {
    const startedServer = app.listen(port, () => {
      resolve(startedServer);
    });

    startedServer.on('error', (error) => {
      reject(error);
    });
  });

  return {
    app,
    server,
    port
  };
}
