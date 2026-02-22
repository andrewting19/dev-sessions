import { describe, expect, it } from 'vitest';
import {
  fromTmuxSessionName,
  generateChampionId,
  toTmuxSessionName
} from '../../src/champion-ids';

describe('champion IDs', () => {
  it('generates IDs in champion-role format', () => {
    const id = generateChampionId();
    expect(id).toMatch(/^[a-z0-9-]+-(top|jg|mid|adc|sup)$/);
  });

  it('round-trips through tmux session names', () => {
    const id = generateChampionId(() => 0);
    const tmuxName = toTmuxSessionName(id);

    expect(tmuxName).toBe(`dev-${id}`);
    expect(fromTmuxSessionName(tmuxName)).toBe(id);
    expect(fromTmuxSessionName('not-a-dev-session')).toBeNull();
  });

  it('has good uniqueness across repeated generation', () => {
    const generated = new Set<string>();

    for (let i = 0; i < 1000; i += 1) {
      generated.add(generateChampionId());
    }

    // 1000 draws from 750 combinations should still yield substantial spread.
    expect(generated.size).toBeGreaterThan(500);
  });
});
