import { NextResponse } from 'next/server'
import { supabaseService } from '@/lib/db/service'
import { supabaseSyncStore } from '@/lib/sync/store'
import { drain } from '@/lib/sync/drain'
import { drainPulls } from '@/lib/sync/pull'
import { authorizeCron, syncContexts } from '@/lib/sync/context'

export const maxDuration = 60

/**
 * Section 7.4: the drain. Called fire and forget after every mutation, and by a
 * Vercel cron every minute as the safety net.
 */
export async function POST(request: Request) {
  const denied = authorizeCron(request)
  if (denied) return denied

  const contexts = await syncContexts()
  if (contexts.length === 0) {
    return NextResponse.json({ ok: true, note: 'Notion sync is not configured' })
  }

  const db = supabaseService()
  const store = supabaseSyncStore(db)
  const results = []

  for (const ctx of contexts) {
    const runId = await store.startRun('drain', ctx.householdId)
    try {
      // Inbound first: a queued pull that renames an item should settle before
      // we push, so we do not push a value we are about to overwrite.
      const { data: pulls } = await db
        .from('sync_jobs')
        .select('id, notion_page_id')
        .eq('household_id', ctx.householdId)
        .eq('direction', 'pull')
        .eq('status', 'queued')
        .lte('run_after', new Date().toISOString())
        .limit(25)

      const pageIds = (pulls ?? [])
        .map((j) => j.notion_page_id as string | null)
        .filter((id): id is string => Boolean(id))

      const pullStats = pageIds.length
        ? await drainPulls({
          store, api: ctx.api,
          householdId: ctx.householdId,
          itemsDataSourceId: ctx.itemsDataSourceId,
        }, pageIds)
        : null

      if (pulls?.length) {
        await db.from('sync_jobs').update({ status: 'done' })
          .in('id', pulls.map((j) => j.id))
      }

      const pushStats = await drain({
        store, api: ctx.api,
        itemsDataSourceId: ctx.itemsDataSourceId,
        locationsDataSourceId: ctx.locationsDataSourceId,
      })

      const stats = { push: pushStats, pull: pullStats }
      await store.finishRun(runId, true, stats)
      results.push({ householdId: ctx.householdId, ...stats })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await store.finishRun(runId, false, { error: message })
      results.push({ householdId: ctx.householdId, error: message })
    }
  }

  return NextResponse.json({ ok: true, results })
}

/** Vercel Cron issues GET. Same work. */
export async function GET(request: Request) {
  return POST(request)
}
