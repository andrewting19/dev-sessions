export type SessionMode = 'yolo' | 'native' | 'docker';

export type SessionStatus = 'active' | 'inactive';

export type AgentTurnStatus = 'idle' | 'working' | 'waiting_for_input';

export interface StoredSession {
  championId: string;
  internalId: string;
  cli: 'claude';
  mode: SessionMode;
  path: string;
  description?: string;
  status: SessionStatus;
  createdAt: string;
  lastUsed: string;
}

export interface WaitResult {
  completed: boolean;
  timedOut: boolean;
  elapsedMs: number;
}
