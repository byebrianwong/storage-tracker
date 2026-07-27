import { test, expect } from '@playwright/test'
import { join } from 'node:path'

/**
 * Section 11 E2E: upload a plan and draw a zone.
 * Also covers the M2 acceptance criterion: geometry survives a reload.
 */

const configured = Boolean(process.env.E2E_STORAGE_STATE)
test.skip(!configured, 'Needs E2E_STORAGE_STATE, a signed in Supabase session. See README.')

test('uploads a plan, draws a zone, and the geometry survives a reload', async ({ page }) => {
  await page.goto('/setup/plan')

  await page.setInputFiles('input[type=file]', join(__dirname, 'fixtures/plan.png'))
  const canvas = page.getByRole('group', { name: /storage areas|floor plan/i })
  await expect(canvas).toBeVisible({ timeout: 30_000 })

  // Rectangle mode is the default, section 5.3.
  const box = await canvas.boundingBox()
  if (!box) throw new Error('plan canvas has no box')

  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35)
  await page.mouse.up()

  // The inline form appears in place, not on a separate page.
  await page.getByLabel(/name/i).first().fill('Entry closet')
  await page.getByRole('button', { name: /save|create/i }).first().click()

  await expect(page.getByText('Entry closet')).toBeVisible()

  await page.reload()
  await expect(page.getByText('Entry closet')).toBeVisible()
})
