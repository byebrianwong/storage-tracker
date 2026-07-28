'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { supabaseServer, currentHousehold } from '@/lib/db/server'
import { selfUrl } from '@/lib/sync/dispatch'
import { NOTION_VERSION, isNotionConfigured } from '@/lib/notion/client'
import {
  createDatabases,
  discoverDataSource,
  notionUrl,
  parseNotionId,
  type NotionDataSourceRef,
} from '@/lib/notion/setup'
import { dispatchDrain } from '@/lib/sync/dispatch'
import { ItemSyncPayloadSchema, type ItemSyncPayload } from '@/lib/types'
import type { ActionResult } from './items'

/**
 * Section 7.2, 7.3 and 7.8. The write half of the settings page.
 *
 * Everything here runs against the request scoped client, so RLS decides which
 * household a row belongs to rather than a parameter the browser sent. Nothing
 * here touches `notion_secrets`: the webhook HMAC key is service role only.
 */

/** A pasted Notion id, a dashed uuid, or the full page URL. Normalized to a uuid. */
const NotionId = z.string().trim().min(1).transform((raw, ctx) => {
  const id = parseNotionId(raw)
  if (!id) {
    ctx.addIssue({
      code: 'custom',
      message: 'Paste a Notion URL, or the 32 character id from it.',
    })
    return z.NEVER
  }
  return id
})

// --------------------------------------------------------------------------
// Connect two databases the user already created
// --------------------------------------------------------------------------

const ConnectDatabases = z.object({
  itemsDatabaseId: NotionId,
  locationsDatabaseId: NotionId,
  /**
   * Section 7.2: when a database holds more than one data source the app refuses
   * to guess, so the UI comes back with the user's pick.
   */
  itemsDataSourceId: NotionId.nullish(),
  locationsDataSourceId: NotionId.nullish(),
})

export type ConnectPending = {
  /** Which database needs a choice, and what the choices are. */
  field: 'itemsDataSourceId' | 'locationsDataSourceId'
  label: string
  choices: NotionDataSourceRef[]
}

export type ConnectDatabasesData = {
  itemsUrl: string | null
  locationsUrl: string | null
  /** Set when the caller must pick a data source and resubmit. */
  pending: ConnectPending | null
}

export async function connectDatabases(
  input: unknown,
): Promise<ActionResult<ConnectDatabasesData>> {
  const parsed = ConnectDatabases.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid database id' }
  }
  if (!isNotionConfigured()) {
    return { ok: false, error: 'NOTION_TOKEN is not set. Add it to the environment first.' }
  }

  const householdId = await currentHousehold()
  if (!householdId) return { ok: false, error: 'Not signed in' }

  const items = await resolveDataSource(
    parsed.data.itemsDatabaseId, parsed.data.itemsDataSourceId ?? null,
  )
  if (!items.ok) {
    return items.pending
      ? { ok: true, data: { itemsUrl: null, locationsUrl: null, pending: { ...items.pending, field: 'itemsDataSourceId', label: 'Storage items' } } }
      : { ok: false, error: items.error }
  }

  const locations = await resolveDataSource(
    parsed.data.locationsDatabaseId, parsed.data.locationsDataSourceId ?? null,
  )
  if (!locations.ok) {
    return locations.pending
      ? { ok: true, data: { itemsUrl: null, locationsUrl: null, pending: { ...locations.pending, field: 'locationsDataSourceId', label: 'Storage locations' } } }
      : { ok: false, error: locations.error }
  }

  if (items.dataSourceId === locations.dataSourceId) {
    return { ok: false, error: 'Both fields point at the same data source. They must be two different databases.' }
  }

  const supabase = await supabaseServer()
  const { error } = await supabase.from('notion_config').upsert({
    household_id: householdId,
    items_database_id: parsed.data.itemsDatabaseId,
    items_data_source_id: items.dataSourceId,
    locations_database_id: parsed.data.locationsDatabaseId,
    locations_data_source_id: locations.dataSourceId,
    // Section 7.6: cursors are not portable across a version change, and the
    // stored version is what a future migration checks them against.
    notion_version: NOTION_VERSION,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'household_id' })

  if (error) return { ok: false, error: error.message }

  revalidatePath('/settings/sync')
  return {
    ok: true,
    data: {
      itemsUrl: items.url ?? notionUrl(parsed.data.itemsDatabaseId),
      locationsUrl: locations.url ?? notionUrl(parsed.data.locationsDatabaseId),
      pending: null,
    },
  }
}

type Resolved =
  | { ok: true; dataSourceId: string; url: string | null }
  | { ok: false; error: string; pending: { choices: NotionDataSourceRef[] } | null }

async function resolveDataSource(databaseId: string, picked: string | null): Promise<Resolved> {
  if (picked) return { ok: true, dataSourceId: picked, url: notionUrl(databaseId) }

  const found = await discoverDataSource(databaseId)
  if (found.ok) return { ok: true, dataSourceId: found.dataSourceId, url: found.url }

  return {
    ok: false,
    error: found.message,
    pending: found.reason === 'multiple_data_sources' ? { choices: found.choices } : null,
  }
}

// --------------------------------------------------------------------------
// Section 7.3: one click "Create databases in Notion"
// --------------------------------------------------------------------------

const CreateNotionDatabases = z.object({ parentPageId: NotionId })

export type CreateNotionDatabasesData = {
  itemsUrl: string | null
  locationsUrl: string | null
}

export async function createNotionDatabases(
  input: unknown,
): Promise<ActionResult<CreateNotionDatabasesData>> {
  const parsed = CreateNotionDatabases.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid page id' }
  }
  if (!isNotionConfigured()) {
    return { ok: false, error: 'NOTION_TOKEN is not set. Add it to the environment first.' }
  }

  const householdId = await currentHousehold()
  if (!householdId) return { ok: false, error: 'Not signed in' }

  const created = await createDatabases(parsed.data.parentPageId)
  if (!created.ok) return { ok: false, error: created.message }

  const supabase = await supabaseServer()
  const { error } = await supabase.from('notion_config').upsert({
    household_id: householdId,
    items_database_id: created.items.databaseId,
    items_data_source_id: created.items.dataSourceId,
    locations_database_id: created.locations.databaseId,
    locations_data_source_id: created.locations.dataSourceId,
    parent_page_id: created.parentPageId,
    notion_version: NOTION_VERSION,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'household_id' })

  if (error) {
    return {
      ok: false,
      error: `The databases were created in Notion but could not be saved: ${error.message}. ` +
        'Connect them by id instead of creating them again.',
    }
  }

  revalidatePath('/settings/sync')
  return { ok: true, data: { itemsUrl: created.items.url, locationsUrl: created.locations.url } }
}

// --------------------------------------------------------------------------
// Section 7.6 and 7.8: the manual "Run full reconcile" button
// --------------------------------------------------------------------------

export type ReconcileSummary = { note: string }

/**
 * Section 7.8. Calls the cron route rather than reimplementing reconcile, so
 * the manual pass and the nightly one are provably the same code path. The
 * CRON_SECRET never leaves the server.
 */
export async function runFullReconcile(): Promise<ActionResult<ReconcileSummary>> {
  const householdId = await currentHousehold()
  if (!householdId) return { ok: false, error: 'Not signed in' }
  if (!isNotionConfigured()) {
    return { ok: false, error: 'Notion is not connected yet.' }
  }

  // Same resolution as the drain dispatch: APP_URL, else Vercel's own vars.
  const base = selfUrl()
  if (!base) return { ok: false, error: 'APP_URL is not set, so the reconcile route cannot be called.' }
  const secret = process.env.CRON_SECRET
  if (!secret) return { ok: false, error: 'CRON_SECRET is not set, so the reconcile route would reject the call.' }

  try {
    const res = await fetch(`${base}/api/sync/reconcile?mode=full`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      cache: 'no-store',
      // A full pass over a large workspace can outlive a Server Action. The
      // route keeps running either way; we stop waiting and say so.
      signal: AbortSignal.timeout(120_000),
    })

    if (!res.ok) {
      return { ok: false, error: `Reconcile failed: HTTP ${res.status} ${res.statusText}` }
    }

    const body = (await res.json()) as {
      note?: string
      results?: { scanned?: number; errors?: string[] }[]
    }

    revalidatePath('/settings/sync')

    if (body.note) return { ok: true, data: { note: body.note } }

    const scanned = (body.results ?? []).reduce((n, r) => n + (r.scanned ?? 0), 0)
    const errors = (body.results ?? []).flatMap((r) => r.errors ?? [])
    return {
      ok: true,
      data: {
        note: errors.length > 0
          ? `Scanned ${scanned} pages, ${errors.length} failed. First: ${errors[0]}`
          : `Scanned ${scanned} ${scanned === 1 ? 'page' : 'pages'}, no errors.`,
      },
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      revalidatePath('/settings/sync')
      return { ok: true, data: { note: 'Still running. Reload in a minute to see the result.' } }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --------------------------------------------------------------------------
// Section 7.5 step 4 and 7.8: resolve a conflict
// --------------------------------------------------------------------------

const ResolveConflict = z.object({
  conflictId: z.uuid(),
  resolution: z.enum(['app', 'notion']),
})

export type ResolveConflictData = { itemId: string | null; resolution: 'app' | 'notion' }

/**
 * Write the chosen side back onto the item and close the conflict.
 *
 * The winning value is written through the ordinary `items` update path, not
 * the suppressed inbound path, precisely *because* that fires the outbound
 * trigger: the next drain pushes the winner to Notion and flips the page's Sync
 * status off Conflict. When Notion already holds the winning value the push is
 * a no-op, dropped by the hash check in 7.4 step 3.
 */
export async function resolveConflict(input: unknown): Promise<ActionResult<ResolveConflictData>> {
  const parsed = ResolveConflict.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid conflict' }
  }
  const { conflictId, resolution } = parsed.data

  const supabase = await supabaseServer()

  const { data: conflict, error: readError } = await supabase
    .from('sync_conflicts')
    .select('id, household_id, item_id, app_value, notion_value, resolved_at')
    .eq('id', conflictId)
    .maybeSingle()

  if (readError) return { ok: false, error: readError.message }
  if (!conflict) return { ok: false, error: 'That conflict no longer exists.' }
  if (conflict.resolved_at) return { ok: false, error: 'That conflict is already resolved.' }

  const raw = resolution === 'app' ? conflict.app_value : conflict.notion_value
  const winner = ItemSyncPayloadSchema.safeParse(raw)
  if (!winner.success) {
    return { ok: false, error: 'The stored conflict values are unreadable, so nothing was changed.' }
  }

  const itemId = conflict.item_id as string | null

  if (itemId) {
    const patch = await itemPatch(supabase, winner.data)
    const { error } = await supabase.from('items').update(patch).eq('id', itemId)
    if (error) return { ok: false, error: error.message }

    // Clear the conflict flag on the link so the sync chip goes quiet. The
    // drain sets it back to synced once the push lands.
    await supabase
      .from('notion_links')
      .update({ status: 'pending', error: null })
      .eq('entity_type', 'item')
      .eq('entity_id', itemId)
  }

  const { error: closeError } = await supabase
    .from('sync_conflicts')
    .update({ resolved_as: resolution, resolved_at: new Date().toISOString() })
    .eq('id', conflictId)

  if (closeError) return { ok: false, error: closeError.message }

  dispatchDrain()
  revalidatePath('/settings/sync')
  revalidatePath('/plan')
  return { ok: true, data: { itemId, resolution } }
}

type WritableSupabase = Awaited<ReturnType<typeof supabaseServer>>

/**
 * Turn a stored sync payload back into an `items` row patch.
 *
 * `location_page_id` is a Notion page id, so it only resolves to a container
 * when a link row exists for it. If it does not, the container is left alone
 * rather than guessed at: dropping an item into Unsorted is not a defensible
 * reading of "keep this side's value".
 */
async function itemPatch(
  supabase: WritableSupabase, payload: ItemSyncPayload,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {
    name: payload.name,
    quantity: payload.quantity,
    category: payload.category,
    tags: payload.tags,
    notes: payload.notes,
    // Section 7.5: archived means soft deleted, never a hard delete.
    deleted_at: payload.archived ? new Date().toISOString() : null,
  }

  if (payload.location_page_id) {
    const { data: link } = await supabase
      .from('notion_links')
      .select('entity_id')
      .eq('entity_type', 'container')
      .eq('notion_page_id', payload.location_page_id)
      .maybeSingle()
    if (link?.entity_id) patch.container_id = link.entity_id as string
  }

  return patch
}
