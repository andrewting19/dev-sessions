export type SessionMode = 'yolo' | 'native' | 'docker';

export type SessionStatus = 'active' | 'inactive';

export type AgentTurnStatus = 'idle' | 'working' | 'waiting_for_input';

export type SessionCli = 'claude' | 'codex';

export type CodexTurnStatus = 'completed' | 'failed' | 'interrupted';

export interface StoredSession {
  championId: string;
  internalId: string;
  cli: SessionCli;
  mode: SessionMode;
  path: string;
  description?: string;
  status: SessionStatus;
  appServerPid?: number;
  model?: string;
  lastTurnStatus?: CodexTurnStatus;
  lastTurnError?: string;
  createdAt: string;
  lastUsed: string;
}

export interface WaitResult {
  completed: boolean;
  timedOut: boolean;
  elapsedMs: number;
}
