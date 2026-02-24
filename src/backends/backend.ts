import { AgentTurnStatus, SessionCli, SessionMode, SessionTurn, StoredSession, WaitResult } from '../types';

export interface BackendCreateOptions {
  championId: string;
  workspacePath: string;
  description?: string;
  mode?: SessionMode;
  model?: string;
}

export interface BackendCreateResult {
  internalId: string;
  mode: SessionMode;
  appServerPid?: number;
  appServerPort?: number;
  model?: string;
  codexTurnInProgress?: boolean;
  lastAssistantMessages?: string[];
}

export interface BackendStatusResult {
  status: AgentTurnStatus;
  storeUpdate?: Partial<StoredSession>;
  errorToThrow?: Error;
}

export interface BackendWaitResult extends WaitResult {
  storeUpdate: Partial<StoredSession>;
  errorToThrow?: Error;
}

export interface Backend {
  readonly cli: SessionCli;
  readonly deadSessionPolicy: 'prune' | 'deactivate';
  isChampionIdTaken(championId: string): Promise<boolean>;
  create(options: BackendCreateOptions): Promise<BackendCreateResult>;
  preSendStoreFields(session: StoredSession, sendTime: string): Partial<StoredSession> | Promise<Partial<StoredSession>>;
  send(session: StoredSession, message: string): Promise<Partial<StoredSession>>;
  onSendError(session: StoredSession, error: Error): Partial<StoredSession>;
  status(session: StoredSession): Promise<BackendStatusResult>;
  wait(session: StoredSession, timeoutMs: number, intervalMs: number): Promise<BackendWaitResult>;
  exists(session: StoredSession): Promise<'alive' | 'dead' | 'unknown'>;
  getLastMessages(session: StoredSession, count: number): Promise<string[]>;
  getLogs(session: StoredSession): Promise<SessionTurn[]>;
  kill(session: StoredSession): Promise<void>;
  afterKill(remainingActiveSessions: StoredSession[]): Promise<void>;
}
