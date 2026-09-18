import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('release CI coverage', () => {
  test('assigns every gated browser suite to exactly one of four nonempty runners', () => {
    const workflow = readFileSync(new URL('../.github/workflows/game.yml', import.meta.url), 'utf8');
    const groups = [...workflow.matchAll(/^\s+files: (.+)$/gm)].map(match => match[1]!.trim().split(/\s+/));
    expect(groups).toHaveLength(4);
    expect(groups.every(files => files.length > 0)).toBe(true);
    const assigned = groups.flat();
    expect(new Set(assigned).size).toBe(assigned.length);
    const browserTests = readdirSync(new URL('.', import.meta.url)).filter(file =>
      file.endsWith('.test.ts') && /describe\.runIf\(process\.env\.KOROVANY_(?:WORLD_)?BROWSER/.test(
        readFileSync(new URL(file, import.meta.url), 'utf8'),
      )).map(file => `tests/${file}`);
    expect(assigned.sort()).toEqual(browserTests.sort());
    expect(workflow).toContain('npm test -- ${{ matrix.files }}');
    expect(workflow).not.toContain('--shard=');
    for (const flag of ['KOROVANY_BROWSER', 'KOROVANY_WORLD_BROWSER', 'KOROVANY_VOICE_ASSETS']) {
      expect(workflow).toContain(`${flag}: "1"`);
    }
  });
});
