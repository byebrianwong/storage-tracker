import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SyncJob, SyncEntity } from '@/lib/types'

/**
 * Every database touch the sync workers make, behind one interface.
 *
 * The workers are written against this rather than against Supabase directly so
 * the conformance suite in section 11 can run them against a real Postgres
 * (PGlite) with the real triggers and constraints, instead of mocking the
 * database and proving nothing.
 */
export interface SyncStore {
  claimJobs(limit: number): Promise<SyncJob[]>
  completeJob(id: string): Promise<void>
  failJob(id: string, error: string, runAfterMs: number, permanent: boolean): Promise<void>
  enqueuePull(householdId: string, notionPageId: string): Promise<void>

  getItem(id: string): Promise<ItemRow | null>
  getContainerContext(id: string): Promise<ContainerContext | null>

  getLink(entityType: SyncEntity, entityId: string): Promise<LinkRow | null>
  getLinkByPage(notionPageId: string): Promise<LinkRow | null>
  upsertLink(row: UpsertLink): Promise<void>
  setLinkStatus(id: string, status: string, error: string | null): Promise<void>

  /**
   * Apply an inbound change with the outbound trigger suppressed.
   * Implementations MUST run `set local app.sync_context = 'notion'` inside the
   * same transaction as the write. See DECISIONS.md decision 2.
   */
  applyInbound(fn: InboundWrite): Promise<void>

  recordConflict(householdId: string, itemId: string, app: unknown, notion: unknown): Promise<void>
  startRun(kind: string, householdId: string | null): Promise<string>
  finishRun(id: string, ok: boolean, stats: unknown, highWater?: string | null): Promise<void>
  lastRunHighWater(kind: string, householdId: string): Promise<string | null>

  notionConfig(householdId: string): Promise<NotionConfigRow | null>
  /** Container used for Notion rows that arrive with no Location. Section 7.5. */
  ensureUnsortedContainer(householdId: string): Promise<string>
}

export type ItemRow = {
  id: string
  household_id: string
  container_id: string | null
  name: string
  quantity: number
  category: string | null
  tags: string[]
  notes: string | null
  deleted_at: string | null
  updated_at: string
}

export type ContainerContext = {
  id: string
  household_id: string
  label: string
  kind: string
  zone_name: string
  shelf_name: string
}

export type LinkRow = {
  id: string
  household_id: string
  entity_type: SyncEntity
  entity_id: string
  notion_page_id: string
  notion_data_source_id: string
  notion_last_edited_time: string | null
  last_pushed_hash: string | null
  last_synced_at: string | null
  status: string
}

export type UpsertLink = {
  householdId: string
  entityType: SyncEntity
  entityId: string
  notionPageId: string
  dataSourceId: string
  lastEditedTime: string | null
  pushedHash: string | null
  status: string
}

export type InboundWrite = {
  itemId?: string
  householdId: string
  values: Partial<ItemRow>
  /** Set when the inbound page is new and has no item yet. */
  insert?: boolean
}

export type NotionConfigRow = {
  household_id: string
  items_data_source_id: string | null
  locations_data_source_id: string | null
  // The webhook HMAC key is deliberately NOT here. It lives in notion_secrets,
  // which is readable only by the service role. See the init migration.
}

/** The Supabase backed implementation, used in production. */
export function supabaseSyncStore(db: SupabaseClient): SyncStore {
  return {
    async claimJobs(limit) {
      // for update skip locked, section 7.4 step 1. Done in a function because
      // PostgREST cannot express row locking.
      const { data, error } = await db.rpc('claim_sync_jobs', { lim: limit })
      if (error) throw error
      return (data ?? []) as SyncJob[]
    },

    async completeJob(id) {
      await db.from('sync_jobs').update({ status: 'done' }).eq('id', id)
    },

    async failJob(id, error, runAfterMs, permanent) {
      await db.from('sync_jobs').update({
        status: permanent ? 'failed' : 'queued',
        last_error: error.slice(0, 2000),
        run_after: new Date(Date.now() + runAfterMs).toISOString(),
      }).eq('id', id)
    },

    async enqueuePull(householdId, notionPageId) {
      await db.from('sync_jobs').insert({
        household_id: householdId, direction: 'pull', entity_type: 'item',
        notion_page_id: notionPageId, op: 'upsert',
      })
    },

    async getItem(id) {
      const { data } = await db.from('items')
        .select('id, household_id, container_id, name, quantity, category, tags, notes, deleted_at, updated_at')
        .eq('id', id).maybeSingle()
      return (data as ItemRow | null) ?? null
    },

    async getContainerContext(id) {
      const { data } = await db.rpc('container_context', { c: id })
      const row = Array.isArray(data) ? data[0] : data
      return (row as ContainerContext | null) ?? null
    },

    async getLink(entityType, entityId) {
      const { data } = await db.from('notion_links').select('*')
        .eq('entity_type', entityType).eq('entity_id', entityId).maybeSingle()
      return (data as LinkRow | null) ?? null
    },

    async getLinkByPage(notionPageId) {
      const { data } = await db.from('notion_links').select('*')
        .eq('notion_page_id', notionPageId).maybeSingle()
      return (data as LinkRow | null) ?? null
    },

    async upsertLink(row) {
      await db.from('notion_links').upsert({
        household_id: row.householdId,
        entity_type: row.entityType,
        entity_id: row.entityId,
        notion_page_id: row.notionPageId,
        notion_data_source_id: row.dataSourceId,
        notion_last_edited_time: row.lastEditedTime,
        last_pushed_hash: row.pushedHash,
        last_synced_at: new Date().toISOString(),
        status: row.status,
        error: null,
      }, { onConflict: 'entity_type,entity_id' })
    },

    async setLinkStatus(id, status, error) {
      await db.from('notion_links').update({ status, error }).eq('id', id)
    },

    async applyInbound(write) {
      const { error } = await db.rpc('apply_inbound_item', {
        p_item_id: write.itemId ?? null,
        p_household_id: write.householdId,
        p_values: write.values,
        p_insert: write.insert ?? false,
      })
      if (error) throw error
    },

    async recordConflict(householdId, itemId, app, notion) {
      await db.from('sync_conflicts').insert({
        household_id: householdId, item_id: itemId,
        app_value: app, notion_value: notion,
      })
    },

    async startRun(kind, householdId) {
      const { data } = await db.from('sync_runs')
        .insert({ kind, household_id: householdId }).select('id').single()
      return data!.id as string
    },

    async finishRun(id, ok, stats, highWater) {
      await db.from('sync_runs').update({
        finished_at: new Date().toISOString(), ok, stats,
        cursor_high_water: highWater ?? null,
      }).eq('id', id)
    },

    async lastRunHighWater(kind, householdId) {
      const { data } = await db.from('sync_runs')
        .select('cursor_high_water')
        .eq('kind', kind).eq('household_id', householdId).eq('ok', true)
        .not('cursor_high_water', 'is', null)
        .order('started_at', { ascending: false }).limit(1).maybeSingle()
      return (data?.cursor_high_water as string | null) ?? null
    },

    async notionConfig(householdId) {
      const { data } = await db.from('notion_config').select('*')
        .eq('household_id', householdId).maybeSingle()
      return (data as NotionConfigRow | null) ?? null
    },

    async ensureUnsortedContainer(householdId) {
      const { data, error } = await db.rpc('ensure_unsorted_container', { h: householdId })
      if (error) throw error
      return data as string
    },
  }
}
