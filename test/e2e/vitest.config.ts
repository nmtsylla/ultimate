import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['test/sweep-temp.ts'],
    setupFiles: ['test/setup.ts'],
    include: ['test/e2e/**/*.test.ts', 'extensions/*/test/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    // #8364: the lander runs this after the fast suite; three workers fits memory and its 180-second budget.
    maxWorkers: 3,
    // Like vite.config.ts: under an agent Vitest's minimal reporter is silent for passing files.
    reporters: ['default'],
  },
})
