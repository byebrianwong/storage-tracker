import { defineConfig, devices } from '@playwright/test'

/**
 * The two happy path flows from section 11.
 *
 * These need a real Supabase project: a signed in session, a Storage bucket, and
 * seeded data. They are skipped unless E2E_BASE_URL and E2E_STORAGE_STATE are
 * set, so `pnpm test` stays runnable with no external services.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    storageState: process.env.E2E_STORAGE_STATE || undefined,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Section 9.4: the app must work at 360px.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'pnpm dev', url: 'http://localhost:3000', reuseExistingServer: true, timeout: 120_000 },
})
