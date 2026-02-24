import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StoredSession } from './types';

interface SessionStoreFile {
  version: number;
  sessions: StoredSession[];
}

const CURRENT_VERSION = 1;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_INTERVAL_MS = 20;
const LOCK_STALE_MS = 30_000;

function getDefaultStorePath(): string {
  return path.join(os.homedir(), '.dev-sessions', 'sessions.json');
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as StoredSession;
  return (
    typeof candidate.championId === 'string' &&
    typeof candidate.internalId === 'string' &&
    (candidate.cli === 'claude' || candidate.cli === 'codex') &&
    (candidate.mode === 'native' || candidate.mode === 'docker') &&
    typeof candidate.path === 'string' &&
    (candidate.description === undefined || typeof candidate.description === 'string') &&
    (candidate.status === 'active' || candidate.status === 'inactive') &&
    (candidate.appServerPid === undefined || Number.isInteger(candidate.appServerPid)) &&
    (candidate.appServerPort === undefined || Number.isInteger(candidate.appServerPort)) &&
    (candidate.model === undefined || typeof candidate.model === 'string') &&
    (candidate.codexTurnInProgress === undefined || typeof candidate.codexTurnInProgress === 'boolean') &&
    (candidate.codexActiveTurnId === undefined || typeof candidate.codexActiveTurnId === 'string') &&
    (candidate.codexLastCompletedAt === undefined || typeof candidate.codexLastCompletedAt === 'string') &&
    (candidate.lastTurnStatus === undefined ||
      candidate.lastTurnStatus === 'completed' ||
      candidate.lastTurnStatus === 'failed' ||
      candidate.lastTurnStatus === 'interrupted') &&
    (candidate.lastTurnError === undefined || typeof candidate.lastTurnError === 'string') &&
    (candidate.lastAssistantMessages === undefined ||
      (Array.isArray(candidate.lastAssistantMessages) &&
        candidate.lastAssistantMessages.every((message) => typeof message === 'string'))) &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.lastUsed === 'string'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SessionStore {
  private readonly lockPath: string;

  constructor(private readonly storePath: string = getDefaultStorePath()) {
    this.lockPath = `${storePath}.lock`;
  }

  get filePath(): string {
    return this.storePath;
  }

  async listSessions(): Promise<StoredSession[]> {
    const store = await this.readStore();
    return [...store.sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSession(championId: string): Promise<StoredSession | undefined> {
    const store = await this.readStore();
    return store.sessions.find((session) => session.championId === championId);
  }

  async upsertSession(session: StoredSession): Promise<void> {
    await this.withLock(async () => {
      const store = await this.readStore();
      const index = store.sessions.findIndex((candidate) => candidate.championId === session.championId);

      if (index >= 0) {
        store.sessions[index] = session;
      } else {
        store.sessions.push(session);
      }

      await this.writeStore(store);
    });
  }

  async updateSession(
    championId: string,
    partial: Partial<Omit<StoredSession, 'championId'>>
  ): Promise<StoredSession | undefined> {
    return this.withLock(async () => {
      const store = await this.readStore();
      const index = store.sessions.findIndex((candidate) => candidate.championId === championId);

      if (index < 0) {
        return undefined;
      }

      const updatedSession: StoredSession = {
        ...store.sessions[index],
        ...partial,
        championId: store.sessions[index].championId
      };

      store.sessions[index] = updatedSession;
      await this.writeStore(store);
      return updatedSession;
    });
  }

  async deleteSession(championId: string): Promise<boolean> {
    return this.withLock(async () => {
      const store = await this.readStore();
      const initialLength = store.sessions.length;
      store.sessions = store.sessions.filter((candidate) => candidate.championId !== championId);

      if (store.sessions.length === initialLength) {
        return false;
      }

      await this.writeStore(store);
      return true;
    });
  }

  async pruneSessions(championIds: string[]): Promise<number> {
    if (championIds.length === 0) {
      return 0;
    }

    return this.withLock(async () => {
      const ids = new Set(championIds);
      const store = await this.readStore();
      const initialLength = store.sessions.length;
      store.sessions = store.sessions.filter((candidate) => !ids.has(candidate.championId));
      const removed = initialLength - store.sessions.length;

      if (removed > 0) {
        await this.writeStore(store);
      }

      return removed;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await fn();
    } finally {
      await this.releaseLock();
    }
  }

  private async acquireLock(): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });

    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
      try {
        await mkdir(this.lockPath);
        return;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }

      // Check for stale lock (e.g. process crashed while holding it)
      try {
        const lockStat = await stat(this.lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(this.lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock dir vanished between our check — retry acquire
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for session store lock at ${this.lockPath}`);
      }

      // Jittered retry to reduce contention
      const jitter = Math.random() * LOCK_RETRY_INTERVAL_MS;
      await sleep(LOCK_RETRY_INTERVAL_MS + jitter);
    }
  }

  private async releaseLock(): Promise<void> {
    await rm(this.lockPath, { recursive: true, force: true });
  }

  private async readStore(): Promise<SessionStoreFile> {
    try {
      const raw = await readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SessionStoreFile>;
      const sessions: StoredSession[] = [];
      if (Array.isArray(parsed.sessions)) {
        for (const [index, candidate] of parsed.sessions.entries()) {
          if (isStoredSession(candidate)) {
            sessions.push(candidate);
            continue;
          }

          const candidateChampionId =
            candidate && typeof candidate === 'object' && typeof (candidate as { championId?: unknown }).championId === 'string'
              ? (candidate as { championId: string }).championId
              : undefined;
          const championIdSuffix = candidateChampionId ? ` championId=${candidateChampionId}` : '';
          console.warn(
            `[dev-sessions] ignoring invalid session record in ${this.storePath} at index ${index}${championIdSuffix}`
          );
        }
      }

      return {
        version: typeof parsed.version === 'number' ? parsed.version : CURRENT_VERSION,
        sessions
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          version: CURRENT_VERSION,
          sessions: []
        };
      }

      throw error;
    }
  }

  private async writeStore(store: SessionStoreFile): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tmpPath = `${this.storePath}.tmp`;
    const payload = JSON.stringify(store, null, 2);

    await writeFile(tmpPath, payload, 'utf8');
    await rename(tmpPath, this.storePath);
  }
}

export function createDefaultSessionStore(): SessionStore {
  return new SessionStore();
}
