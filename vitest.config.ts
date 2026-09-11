import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts', 'src/view/**/*.test.ts'], environment: 'node', testTimeout: 120_000 },
});
