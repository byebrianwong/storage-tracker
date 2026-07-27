import 'server-only'
import type { NotionApi } from '@/lib/notion/api'
import { readAppId } from '@/lib/notion/mappers'
import { pullPage, type PullOutcome } from './pull'
import type { SyncStore } from './store'

export type ReconcileMode = 'incremental' | 'full'

export type ReconcileStats = {
  mode: ReconcileMode
  scanned: number
  outcomes: Partial<Record<PullOutcome, number>>
  errors: string[]
  /** Notion pages with no matching item. Logged, never deleted. Section 7.6. */
  orphanPages: string[]
  /** Items with no notion_links row. Repaired by enqueueing a push. */
  unlinkedItems: number
  highWater: string | null
}

export type ReconcileDeps = {
  store: SyncStore
  api: NotionApi
  householdId: string
  itemsDataSourceId: string
  /** Injected so tests do not depend on the wall clock. */
  now?: () => Date
}

/** Section 7.6: the incremental pass overlaps by 5 minutes to cover clock skew. */
const OVERLAP_MS = 5 * 60_000

/**
 * Section 7.6. Reconciliation, not webhooks, is the correctness mechanism.
 * Webhooks are only the latency mechanism, so this must be able to catch
 * everything on its own.
 */
export async function reconcile(
  deps: ReconcileDeps, mode: ReconcileMode,
): Promise<ReconcileStats> {
  const now = deps.now ?? (() => new Date())
  const runId = await deps.store.startRun(`reconcile:${mode}`, deps.householdId)

  const stats: ReconcileStats = {
    mode, scanned: 0, outcomes: {}, errors: [],
    orphanPages: [], unlinkedItems: 0, highWater: null,
  }

  let editedAfter: string | null = null
  if (mode === 'incremental') {
    const last = await deps.store.lastRunHighWater(`reconcile:${mode}`, deps.householdId)
    if (last) editedAfter = new Date(new Date(last).getTime() - OVERLAP_MS).toISOString()
  }

  const startedAt = now().toISOString()
  let cursor: string | null = null

  try {
    do {
      const page: { pages: Awaited<ReturnType<NotionApi['queryDataSource']>>['pages']; nextCursor: string | null } =
        await deps.api.queryDataSource({
          dataSourceId: deps.itemsDataSourceId,
          editedAfter,
          cursor,
        })

      for (const notionPage of page.pages) {
        stats.scanned++
        try {
          const outcome = await pullPage({
            store: deps.store,
            api: deps.api,
            householdId: deps.householdId,
            itemsDataSourceId: deps.itemsDataSourceId,
          }, notionPage)
          stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1

          if (mode === 'full') {
            const appId = readAppId(notionPage)
            const link = await deps.store.getLinkByPage(notionPage.id)
            if (!appId && !link && outcome === 'skipped') {
              // Section 7.6: report orphans, do not delete them.
              stats.orphanPages.push(notionPage.id)
            }
          }
        } catch (err) {
          stats.errors.push(`${notionPage.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      cursor = page.nextCursor
    } while (cursor)

    // The watermark is the moment the scan started, not when it finished, so a
    // row edited mid-scan is picked up next time rather than skipped.
    stats.highWater = startedAt
    await deps.store.finishRun(runId, stats.errors.length === 0, stats, startedAt)
  } catch (err) {
    stats.errors.push(err instanceof Error ? err.message : String(err))
    await deps.store.finishRun(runId, false, stats, null)
  }

  return stats
}
