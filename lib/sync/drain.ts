import 'server-only'
import type { NotionApi } from '@/lib/notion/api'
import { isPageTrashed, isPermanentNotionError, isRateLimited, retryAfterSeconds } from '@/lib/notion/client'
import { backoffMs, MAX_SYNC_ATTEMPTS } from '@/lib/notion/limiter'
import {
  itemToNotionPageBody, containerToNotionProperties, type NotionSyncStatus,
} from '@/lib/notion/mappers'
import { payloadHash } from './hash'
import type { SyncStore } from './store'
import type { ItemSyncPayload, ContainerSyncPayload, SyncJob } from '@/lib/types'

export type DrainStats = {
  claimed: number
  pushed: number
  skippedByHash: number
  archived: number
  failed: number
  retried: number
}

export type DrainDeps = {
  store: SyncStore
  api: NotionApi
  itemsDataSourceId: string
  locationsDataSourceId: string
}

/**
 * Section 7.4. Outbound, app to Notion.
 *
 * Idempotent by construction: the payload hash short circuits a push whose
 * content already matches what we last sent, so running the drain twice changes
 * nothing the second time (section 11 case 1, and M5's acceptance criterion).
 */
export async function drain(deps: DrainDeps, limit = 25): Promise<DrainStats> {
  const stats: DrainStats = {
    claimed: 0, pushed: 0, skippedByHash: 0, archived: 0, failed: 0, retried: 0,
  }

  const jobs = await deps.store.claimJobs(limit)
  stats.claimed = jobs.length

  // Serially, through the rate limiter inside the api implementation.
  for (const job of jobs) {
    if (job.direction !== 'push') continue
    try {
      const outcome = job.entity_type === 'item'
        ? await pushItem(deps, job)
        : await pushContainer(deps, job)

      if (outcome === 'skipped') stats.skippedByHash++
      else if (outcome === 'archived') stats.archived++
      else stats.pushed++

      await deps.store.completeJob(job.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Section 7.7: a 400 means the schema drifted. Retrying burns quota and
      // will never succeed, so fail it now and surface the message.
      const permanent = isPermanentNotionError(err) || job.attempts >= MAX_SYNC_ATTEMPTS
      const wait = isRateLimited(err)
        ? (retryAfterSeconds(err) ?? 1) * 1000
        : backoffMs(job.attempts)

      await deps.store.failJob(job.id, message, wait, permanent)
      if (permanent) {
        stats.failed++
        if (job.entity_id) {
          const link = await deps.store.getLink(job.entity_type, job.entity_id)
          if (link) await deps.store.setLinkStatus(link.id, 'error', message)
        }
      } else {
        stats.retried++
      }
    }
  }

  return stats
}

type Outcome = 'pushed' | 'skipped' | 'archived'

async function pushItem(deps: DrainDeps, job: SyncJob): Promise<Outcome> {
  if (!job.entity_id) return 'skipped'

  const item = await deps.store.getItem(job.entity_id)
  if (!item) return 'skipped' // hard deleted before we got here

  const link = await deps.store.getLink('item', item.id)

  // The Location relation points at the container's Notion page, so that page
  // has to exist first. If it does not, push it now rather than dropping the
  // relation silently.
  let locationPageId: string | null = null
  if (item.container_id) {
    const containerLink = await deps.store.getLink('container', item.container_id)
    if (containerLink) {
      locationPageId = containerLink.notion_page_id
    } else {
      locationPageId = await createContainerPage(deps, item.container_id)
    }
  }

  const archived = item.deleted_at !== null || job.op === 'archive'

  const payload: ItemSyncPayload = {
    name: item.name,
    quantity: item.quantity,
    category: item.category,
    tags: item.tags ?? [],
    notes: item.notes,
    location_page_id: locationPageId,
    archived,
  }

  // Section 7.4 step 3: identical payload, no API call.
  const hash = payloadHash(payload)
  if (link && link.last_pushed_hash === hash) return 'skipped'

  const body = itemToNotionPageBody(payload, {
    appId: item.id,
    lastSynced: new Date().toISOString(),
    // We only reach here on a successful push, so from the app's point of view
    // this row is synced. A conflict or error status is written by the pull
    // worker and the drain's failure handler respectively.
    syncStatus: 'Synced' satisfies NotionSyncStatus,
  })

  const page = link
    ? await deps.api.updatePage({ pageId: link.notion_page_id, body })
    : await deps.api.createPage({ dataSourceId: deps.itemsDataSourceId, body })

  await deps.store.upsertLink({
    householdId: item.household_id,
    entityType: 'item',
    entityId: item.id,
    notionPageId: page.id,
    dataSourceId: deps.itemsDataSourceId,
    lastEditedTime: page.last_edited_time,
    pushedHash: hash,
    status: 'synced',
  })

  // Section 7.4 step 5: the link row is kept on archive, so a later un-delete
  // reuses the same page instead of orphaning it.
  return archived && isPageTrashed(page) ? 'archived' : 'pushed'
}

async function pushContainer(deps: DrainDeps, job: SyncJob): Promise<Outcome> {
  if (!job.entity_id) return 'skipped'
  const created = await createContainerPage(deps, job.entity_id, job.op === 'archive')
  return created ? 'pushed' : 'skipped'
}

/** Creates or updates the Storage locations row for a container. Section 7.3. */
async function createContainerPage(
  deps: DrainDeps, containerId: string, archived = false,
): Promise<string | null> {
  const ctx = await deps.store.getContainerContext(containerId)
  if (!ctx) return null

  const payload: ContainerSyncPayload = {
    name: `${ctx.zone_name} / ${ctx.shelf_name} / ${ctx.label}`,
    zone: ctx.zone_name,
    shelf: ctx.shelf_name,
    kind: ctx.kind,
    app_id: ctx.id,
  }

  const link = await deps.store.getLink('container', containerId)
  const hash = payloadHash({ ...payload, archived })
  if (link && link.last_pushed_hash === hash) return link.notion_page_id

  const body = {
    properties: containerToNotionProperties(payload),
    ...(archived ? { archived: true } : {}),
  }

  const page = link
    ? await deps.api.updatePage({ pageId: link.notion_page_id, body })
    : await deps.api.createPage({ dataSourceId: deps.locationsDataSourceId, body })

  await deps.store.upsertLink({
    householdId: ctx.household_id,
    entityType: 'container',
    entityId: containerId,
    notionPageId: page.id,
    dataSourceId: deps.locationsDataSourceId,
    lastEditedTime: page.last_edited_time,
    pushedHash: hash,
    status: 'synced',
  })

  return page.id
}
