import type { PGlite } from '@electric-sql/pglite'
import type {
  SyncStore, ItemRow, ContainerContext, LinkRow, UpsertLink, InboundWrite, NotionConfigRow,
} from '@/lib/sync/store'
import type { SyncJob, SyncEntity } from '@/lib/types'

/**
 * SyncStore over PGlite, so the conformance suite exercises the real triggers,
 * the real echo suppression path, and the real constraints. Only the network is
 * faked; the database is genuine Postgres.
 */
export function pgliteSyncStore(db: PGlite): SyncStore {
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
    const { rows } = await db.query<T>(sql, params as never[])
    return rows[0] ?? null
  }

  return {
    async claimJobs(limit) {
      const { rows } = await db.query<SyncJob>(
        `select * from claim_sync_jobs($1)`, [limit] as never[],
      )
      return rows
    },

    async completeJob(id) {
      await db.query(`update sync_jobs set status='done' where id=$1`, [Number(id)] as never[])
    },

    async failJob(id, error, runAfterMs, permanent) {
      await db.query(
        `update sync_jobs set status=$2, last_error=$3, run_after = now() + ($4 || ' milliseconds')::interval
         where id=$1`,
        [Number(id), permanent ? 'failed' : 'queued', error.slice(0, 2000), String(runAfterMs)] as never[],
      )
    },

    async enqueuePull(householdId, notionPageId) {
      await db.query(
        `insert into sync_jobs (household_id, direction, entity_type, notion_page_id, op)
         values ($1,'pull','item',$2,'upsert')`,
        [householdId, notionPageId] as never[],
      )
    },

    async getItem(id) {
      return one<ItemRow>(
        `select id, household_id, container_id, name, quantity, category, tags, notes,
                deleted_at, updated_at from items where id=$1`, [id],
      )
    },

    async getContainerContext(id) {
      return one<ContainerContext>(`select * from container_context($1)`, [id])
    },

    async getLink(entityType: SyncEntity, entityId) {
      return one<LinkRow>(
        `select * from notion_links where entity_type=$1 and entity_id=$2`, [entityType, entityId],
      )
    },

    async getLinkByPage(notionPageId) {
      return one<LinkRow>(`select * from notion_links where notion_page_id=$1`, [notionPageId])
    },

    async upsertLink(row: UpsertLink) {
      await db.query(
        `insert into notion_links (household_id, entity_type, entity_id, notion_page_id,
           notion_data_source_id, notion_last_edited_time, last_pushed_hash, last_synced_at, status)
         values ($1,$2,$3,$4,$5,$6,$7, now(), $8)
         on conflict (entity_type, entity_id) do update set
           notion_page_id = excluded.notion_page_id,
           notion_data_source_id = excluded.notion_data_source_id,
           notion_last_edited_time = excluded.notion_last_edited_time,
           last_pushed_hash = excluded.last_pushed_hash,
           last_synced_at = excluded.last_synced_at,
           status = excluded.status,
           error = null`,
        [row.householdId, row.entityType, row.entityId, row.notionPageId, row.dataSourceId,
          row.lastEditedTime, row.pushedHash, row.status] as never[],
      )
    },

    async setLinkStatus(id, status, error) {
      await db.query(`update notion_links set status=$2, error=$3 where id=$1`,
        [id, status, error] as never[])
    },

    async applyInbound(write: InboundWrite) {
      await db.query(
        `select apply_inbound_item($1,$2,$3::jsonb,$4)`,
        [write.itemId ?? null, write.householdId, JSON.stringify(write.values), write.insert ?? false] as never[],
      )
    },

    async recordConflict(householdId, itemId, app, notion) {
      await db.query(
        `insert into sync_conflicts (household_id, item_id, app_value, notion_value)
         values ($1,$2,$3::jsonb,$4::jsonb)`,
        [householdId, itemId, JSON.stringify(app), JSON.stringify(notion)] as never[],
      )
    },

    async startRun(kind, householdId) {
      const row = await one<{ id: string }>(
        `insert into sync_runs (kind, household_id) values ($1,$2) returning id`,
        [kind, householdId],
      )
      return row!.id
    },

    async finishRun(id, ok, stats, highWater) {
      await db.query(
        `update sync_runs set finished_at=now(), ok=$2, stats=$3::jsonb, cursor_high_water=$4 where id=$1`,
        [id, ok, JSON.stringify(stats), highWater ?? null] as never[],
      )
    },

    async lastRunHighWater(kind, householdId) {
      const row = await one<{ cursor_high_water: string | null }>(
        `select cursor_high_water from sync_runs
         where kind=$1 and household_id=$2 and ok is true and cursor_high_water is not null
         order by started_at desc limit 1`, [kind, householdId],
      )
      return row?.cursor_high_water ?? null
    },

    async notionConfig(householdId) {
      return one<NotionConfigRow>(`select * from notion_config where household_id=$1`, [householdId])
    },

    async ensureUnsortedContainer(householdId) {
      const row = await one<{ ensure_unsorted_container: string }>(
        `select ensure_unsorted_container($1)`, [householdId],
      )
      return row!.ensure_unsorted_container
    },
  }
}
