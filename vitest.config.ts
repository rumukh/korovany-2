import { configDefaults, defineConfig } from 'vitest/config';

const suite = process.env.KOROVANY_TEST_SUITE;
if (suite && suite !== 'unit' && suite !== 'browser') throw new Error(`Unknown test suite: ${suite}`);
const browserFiles = ['tests/*-browser.test.ts', 'tests/faction-presentation.test.ts'];
const exclude = [...configDefaults.exclude];
if (suite === 'unit') exclude.push(browserFiles[0]!);
if (suite === 'browser' && process.env.KOROVANY_WORLD_BROWSER !== '1') {
  exclude.push('tests/world-browser.test.ts');
}

export default defineConfig({
  test: {
    include: suite === 'browser' ? browserFiles : ['tests/**/*.test.ts', 'src/view/**/*.test.ts'],
    exclude,
    environment: 'node',
    testTimeout: 120_000,
    // SwiftShader browsers must not compete with each other or simulation suites.
    fileParallelism: process.env.KOROVANY_BROWSER !== '1' && process.env.KOROVANY_WORLD_BROWSER !== '1',
  },
});
