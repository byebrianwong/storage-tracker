import 'server-only'
import type { NotionApi, NotionPage } from '@/lib/notion/api'
import { isPageTrashed } from '@/lib/notion/client'
import { notionPageToItemPayload, readAppId, NotionSchemaError } from '@/lib/notion/mappers'
import { payloadHash } from './hash'
import type { SyncStore, ItemRow } from './store'
import type { ItemSyncPayload } from '@/lib/types'

export type PullOutcome =
  | 'applied'
  | 'created'
  | 'dropped_echo_timestamp'
  | 'dropped_echo_hash'
  | 'conflict'
  | 'archived'
  | 'skipped'

export type PullDeps = {
  store: SyncStore
  api: NotionApi
  householdId: string
  itemsDataSourceId: string
}

/**
 * Section 7.5. Inbound, Notion to app.
 *
 * Both echo checks are load bearing and both are needed. Notion's
 * last_edited_time has second granularity in practice, so a fast round trip can
 * produce an inbound event whose timestamp is not strictly greater than the one
 * we recorded on push; the hash catches those. Conversely the hash only covers
 * fields we mirror, so a Notion-side edit to something we ignore should still be
 * dropped rather than re-applied; the timestamp catches those.
 */
export async function pullPage(
  deps: PullDeps, page: NotionPage,
): Promise<PullOutcome> {
  const link = await deps.store.getLinkByPage(page.id)

  // Section 7.5 step 3, first check: nothing newer than what we already have.
  if (link?.notion_last_edited_time
      && new Date(page.last_edited_time) <= new Date(link.notion_last_edited_time)) {
    return 'dropped_echo_timestamp'
  }

  let payload: ItemSyncPayload
  try {
    payload = notionPageToItemPayload(page)
  } catch (err) {
    // Section 11 case 10: a renamed or retyped property must fail loudly rather
    // than writing nulls over good data.
    if (err instanceof NotionSchemaError && link) {
      await deps.store.setLinkStatus(link.id, 'error', err.message)
    }
    throw err
  }

  // Second check: identical content to what we last pushed.
  const inboundHash = payloadHash(payload)
  if (link?.last_pushed_hash === inboundHash) {
    // Record that we have seen this revision so the timestamp check catches the
    // next duplicate without recomputing.
    await deps.store.upsertLink({
      householdId: link.household_id,
      entityType: 'item',
      entityId: link.entity_id,
      notionPageId: page.id,
      dataSourceId: deps.itemsDataSourceId,
      lastEditedTime: page.last_edited_time,
      pushedHash: link.last_pushed_hash,
      status: 'synced',
    })
    return 'dropped_echo_hash'
  }

  const appId = readAppId(page)
  const existing = appId ? await deps.store.getItem(appId) : null

  // A page whose App ID points at nothing, and with no link row, is a row a
  // human created in Notion.
  if (!existing) {
    return createFromNotion(deps, page, payload)
  }

  const trashed = isPageTrashed(page)

  // Section 7.5 step 4: both sides changed since the last sync.
  if (link?.last_synced_at
      && new Date(existing.updated_at) > new Date(link.last_synced_at)) {
    const appValue = itemToPayloadShape(existing, link.notion_page_id)
    const appIsNewer = new Date(existing.updated_at) > new Date(page.last_edited_time)

    await deps.store.recordConflict(deps.householdId, existing.id, appValue, payload)

    if (!appIsNewer) {
      // Notion is newer: apply it, but still leave the conflict row for review.
      await apply(deps, existing, payload, trashed)
    }

    // Advance the watermark either way.
    //
    // Without this the next reconcile sees the same page again with
    // last_edited_time still ahead of the recorded one, re-detects the same
    // disagreement, and writes a SECOND conflict row. M7 requires exactly one.
    //
    // last_pushed_hash only moves when Notion won, because then the app's state
    // equals the inbound payload. When the app won we must leave it alone, or we
    // would suppress the very push that carries the winning value back.
    await deps.store.upsertLink({
      householdId: deps.householdId,
      entityType: 'item',
      entityId: existing.id,
      notionPageId: page.id,
      dataSourceId: deps.itemsDataSourceId,
      lastEditedTime: page.last_edited_time,
      pushedHash: appIsNewer ? link.last_pushed_hash : inboundHash,
      status: 'conflict',
    })
    await deps.store.setLinkStatus(link.id, 'conflict', 'Both sides changed')
    return 'conflict'
  }

  await apply(deps, existing, payload, trashed)

  if (link) {
    await deps.store.upsertLink({
      householdId: deps.householdId,
      entityType: 'item',
      entityId: existing.id,
      notionPageId: page.id,
      dataSourceId: deps.itemsDataSourceId,
      lastEditedTime: page.last_edited_time,
      // The app's state now equals the inbound payload, so that is what a
      // subsequent push would send. Recording it here stops the echo at source.
      pushedHash: inboundHash,
      status: 'synced',
    })
  }

  return trashed ? 'archived' : 'applied'
}

async function apply(
  deps: PullDeps, existing: ItemRow, payload: ItemSyncPayload, trashed: boolean,
) {
  const containerId = await resolveContainer(deps, payload.location_page_id, existing.container_id)

  await deps.store.applyInbound({
    itemId: existing.id,
    householdId: deps.householdId,
    values: {
      name: payload.name,
      quantity: payload.quantity,
      category: payload.category,
      tags: payload.tags,
      notes: payload.notes,
      container_id: containerId,
      // Section 7.5: archived in Notion means soft delete, never a hard delete.
      deleted_at: trashed
        ? (existing.deleted_at ?? new Date().toISOString())
        : null,
    },
  })
}

async function createFromNotion(
  deps: PullDeps, page: NotionPage, payload: ItemSyncPayload,
): Promise<PullOutcome> {
  if (isPageTrashed(page)) return 'skipped' // archived before we ever saw it

  const containerId = await resolveContainer(deps, payload.location_page_id, null)

  await deps.store.applyInbound({
    householdId: deps.householdId,
    insert: true,
    values: {
      name: payload.name,
      quantity: payload.quantity,
      category: payload.category,
      tags: payload.tags,
      notes: payload.notes,
      container_id: containerId,
    },
  })

  return 'created'
}

/**
 * Section 7.5: a Location relation resolves to the container it points at.
 * Without one, the item lands in a lazily created "Unsorted" container.
 */
async function resolveContainer(
  deps: PullDeps, locationPageId: string | null, fallback: string | null,
): Promise<string | null> {
  if (locationPageId) {
    const link = await deps.store.getLinkByPage(locationPageId)
    if (link?.entity_type === 'container') return link.entity_id
  }
  if (fallback) return fallback
  return deps.store.ensureUnsortedContainer(deps.householdId)
}

function itemToPayloadShape(item: ItemRow, locationPageId: string | null): ItemSyncPayload {
  return {
    name: item.name,
    quantity: item.quantity,
    category: item.category,
    tags: item.tags ?? [],
    notes: item.notes,
    location_page_id: locationPageId,
    archived: item.deleted_at !== null,
  }
}

/** Drain queued pull jobs, fetching each page's current state. Section 7.5 step 1. */
export async function drainPulls(
  deps: PullDeps, pageIds: string[],
): Promise<Record<PullOutcome, number>> {
  const tally = {
    applied: 0, created: 0, dropped_echo_timestamp: 0, dropped_echo_hash: 0,
    conflict: 0, archived: 0, skipped: 0,
  } as Record<PullOutcome, number>

  for (const id of pageIds) {
    const page = await deps.api.retrievePage(id)
    const outcome = await pullPage(deps, page)
    tally[outcome]++
  }
  return tally
}
