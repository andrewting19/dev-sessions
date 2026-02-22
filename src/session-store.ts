import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StoredSession } from './types';

interface SessionStoreFile {
  version: number;
  sessions: StoredSession[];
}

const CURRENT_VERSION = 1;

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
    (candidate.mode === 'yolo' || candidate.mode === 'native' || candidate.mode === 'docker') &&
    typeof candidate.path === 'string' &&
    (candidate.description === undefined || typeof candidate.description === 'string') &&
    (candidate.status === 'active' || candidate.status === 'inactive') &&
    (candidate.appServerPid === undefined || Number.isInteger(candidate.appServerPid)) &&
    (candidate.model === undefined || typeof candidate.model === 'string') &&
    (candidate.lastTurnStatus === undefined ||
      candidate.lastTurnStatus === 'completed' ||
      candidate.lastTurnStatus === 'failed' ||
      candidate.lastTurnStatus === 'interrupted') &&
    (candidate.lastTurnError === undefined || typeof candidate.lastTurnError === 'string') &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.lastUsed === 'string'
  );
}

export class SessionStore {
  constructor(private readonly storePath: string = getDefaultStorePath()) {}

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
    const store = await this.readStore();
    const index = store.sessions.findIndex((candidate) => candidate.championId === session.championId);

    if (index >= 0) {
      store.sessions[index] = session;
    } else {
      store.sessions.push(session);
    }

    await this.writeStore(store);
  }

  async updateSession(
    championId: string,
    partial: Partial<Omit<StoredSession, 'championId'>>
  ): Promise<StoredSession | undefined> {
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
  }

  async deleteSession(championId: string): Promise<boolean> {
    const store = await this.readStore();
    const initialLength = store.sessions.length;
    store.sessions = store.sessions.filter((candidate) => candidate.championId !== championId);

    if (store.sessions.length === initialLength) {
      return false;
    }

    await this.writeStore(store);
    return true;
  }

  async pruneSessions(championIds: string[]): Promise<number> {
    if (championIds.length === 0) {
      return 0;
    }

    const ids = new Set(championIds);
    const store = await this.readStore();
    const initialLength = store.sessions.length;
    store.sessions = store.sessions.filter((candidate) => !ids.has(candidate.championId));
    const removed = initialLength - store.sessions.length;

    if (removed > 0) {
      await this.writeStore(store);
    }

    return removed;
  }

  private async readStore(): Promise<SessionStoreFile> {
    try {
      const raw = await readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SessionStoreFile>;
      const sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions.filter(isStoredSession)
        : [];

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
