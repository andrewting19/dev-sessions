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

export type ThreadGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalUpdate {
  objective?: string;
  status?: ThreadGoalStatus;
  tokenBudget?: number | null;
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
