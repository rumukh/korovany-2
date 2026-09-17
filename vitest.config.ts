import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/view/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    // SwiftShader browsers must not compete with each other or simulation suites.
    fileParallelism: process.env.KOROVANY_BROWSER !== '1' && process.env.KOROVANY_WORLD_BROWSER !== '1',
  },
});
