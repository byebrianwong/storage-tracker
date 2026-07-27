import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'lib/**/*.test.ts'],
    // Playwright owns e2e/; vitest must not try to run those.
    exclude: ['e2e/**', 'node_modules/**'],
    // PGlite boots a WASM Postgres per suite; the default 5s is too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
      // `server-only` throws on import outside a React Server Component, and
      // vitest's node environment does not apply the react-server condition.
      // Stub it once here so sync modules can be imported directly by tests.
      'server-only': resolve(__dirname, 'test/stubs/server-only.ts'),
    },
  },
})
