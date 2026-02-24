export type SessionMode = 'native' | 'docker';

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
  appServerPort?: number;
  model?: string;
  codexTurnInProgress?: boolean;
  codexActiveTurnId?: string;
  codexLastCompletedAt?: string;
  lastTurnStatus?: CodexTurnStatus;
  lastTurnError?: string;
  lastAssistantMessages?: string[];
  claudeSystemCountAtSend?: number;
  createdAt: string;
  lastUsed: string;
}

export interface WaitResult {
  completed: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

export interface SessionTurn {
  role: 'human' | 'assistant';
  text: string;
}
