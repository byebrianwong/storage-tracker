import { NextResponse } from 'next/server'
import { reconcile } from '@/lib/sync/reconcile'
import { authorizeCron, syncContexts } from '@/lib/sync/context'

export const maxDuration = 300

/**
 * Section 7.6. `?mode=full` for the nightly pass, incremental otherwise.
 * The settings page calls this with mode=full for "Run full reconcile".
 */
export async function POST(request: Request) {
  const denied = authorizeCron(request)
  if (denied) return denied

  const mode = new URL(request.url).searchParams.get('mode') === 'full' ? 'full' : 'incremental'
  const contexts = await syncContexts()
  if (contexts.length === 0) {
    return NextResponse.json({ ok: true, note: 'Notion sync is not configured' })
  }

  const results = []
  for (const ctx of contexts) {
    results.push(await reconcile({
      store: ctx.store,
      api: ctx.api,
      householdId: ctx.householdId,
      itemsDataSourceId: ctx.itemsDataSourceId,
    }, mode))
  }

  return NextResponse.json({ ok: true, mode, results })
}

export async function GET(request: Request) {
  return POST(request)
}
