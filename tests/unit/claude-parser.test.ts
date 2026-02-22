import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countAssistantMessages,
  getAssistantTextBlocks,
  getClaudeTranscriptPath,
  hasAssistantResponseAfterLatestUser,
  inferTranscriptStatus,
  readClaudeTranscript,
  sanitizeWorkspacePath
} from '../../src/transcript/claude-parser';

const fixturesDir = path.resolve('tests/fixtures/transcripts');

describe('claude transcript parser', () => {
  it('sanitizes workspace path for transcript location', () => {
    expect(sanitizeWorkspacePath('/Users/andrew/projects/dev-sessions'))
      .toBe('-Users-andrew-projects-dev-sessions');
  });

  it('builds transcript file path from workspace and internal id', () => {
    const transcriptPath = getClaudeTranscriptPath('/Users/test/repo', 'abc-123', '/tmp/home');
    expect(transcriptPath).toBe('/tmp/home/.claude/projects/-Users-test-repo/abc-123.jsonl');
  });

  it('extracts assistant text blocks from transcript', async () => {
    const entries = await readClaudeTranscript(path.join(fixturesDir, 'assistant-blocks.jsonl'));
    const blocks = getAssistantTextBlocks(entries);

    expect(blocks).toEqual([
      'Starting implementation.',
      'Done with changes.',
      'Added tests as requested.'
    ]);
  });

  it('ignores non-text assistant blocks when extracting text', () => {
    const blocks = getAssistantTextBlocks([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Proceed?' } },
            { type: 'text', text: 'Need your confirmation.' }
          ]
        }
      }
    ]);

    expect(blocks).toEqual(['Need your confirmation.']);
  });

  it('infers idle/working/waiting statuses', async () => {
    const idleEntries = await readClaudeTranscript(path.join(fixturesDir, 'status-idle.jsonl'));
    const workingEntries = await readClaudeTranscript(path.join(fixturesDir, 'status-working.jsonl'));
    const waitingEntries = await readClaudeTranscript(path.join(fixturesDir, 'status-waiting.jsonl'));

    expect(inferTranscriptStatus(idleEntries)).toBe('idle');
    expect(inferTranscriptStatus(workingEntries)).toBe('working');
    expect(inferTranscriptStatus(waitingEntries)).toBe('waiting_for_input');
  });

  it('does not mark waiting_for_input from plain text mention of ask_user', () => {
    const entries = [
      { type: 'human', message: { content: 'What next?' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'I can call ask_user if needed.' }] } }
    ];

    expect(inferTranscriptStatus(entries)).toBe('idle');
  });

  it('recognizes request_user_input tool calls as waiting_for_input', () => {
    const entries = [
      { type: 'human', message: { content: 'Pick one option' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'request_user_input', input: { question: 'A or B?' } }
          ]
        }
      }
    ];

    expect(inferTranscriptStatus(entries)).toBe('waiting_for_input');
  });

  it('detects assistant response after latest user message', async () => {
    const idleEntries = await readClaudeTranscript(path.join(fixturesDir, 'status-idle.jsonl'));
    const workingEntries = await readClaudeTranscript(path.join(fixturesDir, 'status-working.jsonl'));

    expect(hasAssistantResponseAfterLatestUser(idleEntries)).toBe(true);
    expect(hasAssistantResponseAfterLatestUser(workingEntries)).toBe(false);
  });

  it('counts assistant messages accurately', async () => {
    const entries = await readClaudeTranscript(path.join(fixturesDir, 'assistant-blocks.jsonl'));
    expect(countAssistantMessages(entries)).toBe(2);
  });
});
