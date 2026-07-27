import { test, expect } from '@playwright/test'

/**
 * Section 11 E2E: find an item by search and open its container.
 * Also covers the M4 acceptance criterion end to end.
 */

const configured = Boolean(process.env.E2E_STORAGE_STATE)
test.skip(!configured, 'Needs E2E_STORAGE_STATE, a signed in Supabase session. See README.')

test('finds an item by search and opens its container', async ({ page }) => {
  await page.goto('/plan')

  const search = page.getByRole('combobox', { name: /find an item/i })
  await expect(search).toBeVisible()

  await search.fill('sleeping bag')

  const results = page.getByRole('listbox')
  await expect(results).toBeVisible()

  const first = results.getByRole('option').first()
  // Every result carries its full location path, section 8.
  await expect(first).toContainText('/')
  await first.click()

  // Deep links into the elevation with the container selected.
  await expect(page).toHaveURL(/\/zone\/[0-9a-f-]+\?container=/)
  await expect(page.getByRole('complementary')).toBeVisible()
})

test('finds a misspelled item name', async ({ page }) => {
  await page.goto('/plan')
  await page.getByRole('combobox', { name: /find an item/i }).fill('sleping bag')
  await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible()
})

test('Cmd K focuses search from anywhere', async ({ page }) => {
  await page.goto('/plan')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('combobox', { name: /find an item/i })).toBeFocused()
})
