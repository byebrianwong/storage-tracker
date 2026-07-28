import 'server-only'

/**
 * Where to call ourselves. APP_URL wins when set; otherwise Vercel's own
 * variables, so a deployment does not need its own URL configured before it can
 * exist. VERCEL_PROJECT_PRODUCTION_URL is the stable production domain,
 * VERCEL_URL the per-deployment one, and both come without a scheme.
 */
export function selfUrl(): string | null {
  if (process.env.APP_URL) return process.env.APP_URL
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
  return host ? `https://${host}` : null
}

/**
 * Section 7.4: after any Server Action mutation, fire and forget a drain so the
 * common case is fast. Never awaited beyond dispatch, and never allowed to fail
 * a user's write. The daily cron in vercel.json is the safety net; the webhook
 * dispatches this too, so inbound latency does not depend on the schedule.
 */
export function dispatchDrain(): void {
  if (!process.env.NOTION_TOKEN) return // sync disabled, nothing to drain
  const base = selfUrl()
  if (!base) return

  const secret = process.env.CRON_SECRET
  void fetch(`${base}/api/sync/drain`, {
    method: 'POST',
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    // Do not keep the serverless invocation alive waiting on this.
    keepalive: true,
  }).catch(() => {
    // The queue row is already committed. A failed dispatch only costs latency,
    // the cron picks it up within the minute.
  })
}
