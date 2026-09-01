import { describe, expect, it } from 'vitest';
import { resolveCodexExecutable } from '../../src/backends/codex-appserver';

describe('Codex executable resolution', () => {
  it('uses an explicit executable override', () => {
    expect(resolveCodexExecutable('  /custom/codex  ', 'darwin', true)).toBe('/custom/codex');
  });

  it('uses the stable app binary on macOS when it is installed', () => {
    expect(resolveCodexExecutable(undefined, 'darwin', true)).toBe(
      '/Applications/ChatGPT.app/Contents/Resources/codex'
    );
  });

  it('falls back to PATH outside macOS or when the app binary is absent', () => {
    expect(resolveCodexExecutable(undefined, 'linux', true)).toBe('codex');
    expect(resolveCodexExecutable(undefined, 'darwin', false)).toBe('codex');
  });
});
