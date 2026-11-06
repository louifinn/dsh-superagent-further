import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    // These specs drive real timers, SQLite and the executor, and a laptop running a second full suite next to this one
    // can starve a single test for more than the 5 s default; 30 s keeps the run honest without hiding a real hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
