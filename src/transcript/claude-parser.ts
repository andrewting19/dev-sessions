import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentTurnStatus } from '../types';

export interface ClaudeTranscriptEntry {
  type?: string;
  message?: {
    content?: unknown;
  };
  [key: string]: unknown;
}

const WAITING_TOOL_NAMES = new Set([
  'askuserquestion',
  'ask_user',
  'ask_human',
  'request_user_input',
  'requestuserinput'
]);

export function sanitizeWorkspacePath(workspacePath: string): string {
  // Claude normalizes project directory names by replacing non-alphanumeric characters with "-".
  return path.resolve(workspacePath).replace(/[^a-zA-Z0-9]/g, '-');
}

export function getClaudeTranscriptPath(
  workspacePath: string,
  internalId: string,
  homeDir: string = os.homedir()
): string {
  const sanitizedWorkspacePath = sanitizeWorkspacePath(workspacePath);
  return path.join(homeDir, '.claude', 'projects', sanitizedWorkspacePath, `${internalId}.jsonl`);
}

export async function readClaudeTranscript(filePath: string): Promise<ClaudeTranscriptEntry[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split('\n');
    const entries: ClaudeTranscriptEntry[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as ClaudeTranscriptEntry;
        entries.push(parsed);
      } catch {
        // Ignore malformed lines to keep parsing resilient.
      }
    }

    return entries;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export function extractTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [content] : [];
  }

  if (Array.isArray(content)) {
    const textBlocks: string[] = [];

    for (const item of content) {
      textBlocks.push(...extractTextBlocks(item));
    }

    return textBlocks;
  }

  if (!content || typeof content !== 'object') {
    return [];
  }

  const record = content as Record<string, unknown>;
  const blockType = typeof record.type === 'string' ? record.type.toLowerCase() : undefined;

  if (
    typeof record.text === 'string' &&
    record.text.length > 0 &&
    (blockType === undefined || blockType === 'text')
  ) {
    return [record.text];
  }

  if (record.content !== undefined) {
    return extractTextBlocks(record.content);
  }

  return [];
}

function isHumanMessage(entry: ClaudeTranscriptEntry): boolean {
  const normalizedType = entry.type?.toLowerCase();
  return normalizedType === 'human' || normalizedType === 'user';
}

function isAssistantMessage(entry: ClaudeTranscriptEntry): boolean {
  return entry.type?.toLowerCase() === 'assistant';
}

function isWaitingToolName(value: unknown): boolean {
  return typeof value === 'string' && WAITING_TOOL_NAMES.has(value.toLowerCase());
}

function containsAskUserToolCall(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsAskUserToolCall(item));
  }

  if (typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  const blockType = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  const functionValue =
    record.function && typeof record.function === 'object'
      ? (record.function as Record<string, unknown>)
      : undefined;

  const hasKnownToolName =
    isWaitingToolName(record.name) ||
    isWaitingToolName(record.tool) ||
    isWaitingToolName(record.tool_name) ||
    isWaitingToolName(functionValue?.name);

  const hasToolShape =
    blockType.includes('tool') ||
    blockType === 'function_call' ||
    record.input !== undefined ||
    record.arguments !== undefined ||
    record.tool !== undefined ||
    record.tool_name !== undefined ||
    functionValue !== undefined;

  if (hasKnownToolName && hasToolShape) {
    return true;
  }

  return Object.values(record).some((item) => containsAskUserToolCall(item));
}

export function getAssistantTextBlocks(entries: ClaudeTranscriptEntry[]): string[] {
  const assistantBlocks: string[] = [];

  for (const entry of entries) {
    if (!isAssistantMessage(entry)) {
      continue;
    }

    assistantBlocks.push(...extractTextBlocks(entry.message?.content));
  }

  return assistantBlocks;
}

export function countAssistantMessages(entries: ClaudeTranscriptEntry[]): number {
  return entries.reduce((count, entry) => count + (isAssistantMessage(entry) ? 1 : 0), 0);
}

function findLastIndex(
  entries: ClaudeTranscriptEntry[],
  predicate: (entry: ClaudeTranscriptEntry) => boolean
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) {
      return index;
    }
  }

  return -1;
}

export function inferTranscriptStatus(entries: ClaudeTranscriptEntry[]): AgentTurnStatus {
  if (entries.length === 0) {
    return 'idle';
  }

  let lastHumanIndex = -1;
  let lastAskUserIndex = -1;

  entries.forEach((entry, index) => {
    if (isHumanMessage(entry)) {
      lastHumanIndex = index;
    }

    if (isAssistantMessage(entry) && containsAskUserToolCall(entry)) {
      lastAskUserIndex = index;
    }
  });

  if (lastAskUserIndex > lastHumanIndex) {
    return 'waiting_for_input';
  }

  const lastEntry = entries[entries.length - 1];
  if (isAssistantMessage(lastEntry)) {
    return 'idle';
  }

  if (isHumanMessage(lastEntry)) {
    return 'working';
  }

  const lastAssistantIndex = findLastIndex(entries, (entry) => isAssistantMessage(entry));
  return lastAssistantIndex > lastHumanIndex ? 'idle' : 'working';
}

export function hasAssistantResponseAfterLatestUser(entries: ClaudeTranscriptEntry[]): boolean {
  const lastHumanIndex = findLastIndex(entries, (entry) => isHumanMessage(entry));

  if (lastHumanIndex < 0) {
    return entries.some((entry) => isAssistantMessage(entry));
  }

  return entries.slice(lastHumanIndex + 1).some((entry) => isAssistantMessage(entry));
}
