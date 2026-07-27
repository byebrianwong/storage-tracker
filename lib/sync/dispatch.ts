import 'server-only'

/**
 * Section 7.4: after any Server Action mutation, fire and forget a drain so the
 * common case is fast. Never awaited beyond dispatch, and never allowed to fail
 * a user's write. The Vercel cron in vercel.json is the safety net.
 */
export function dispatchDrain(): void {
  if (!process.env.NOTION_TOKEN) return // sync disabled, nothing to drain
  const base = process.env.APP_URL
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
