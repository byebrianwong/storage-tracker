import { it, expect, beforeEach, afterEach, describe } from 'vitest'
import { freshDb, seedHousehold, type TestDb } from './pg'
import { FakeNotion } from './fakes/notion'
import { pgliteSyncStore } from './fakes/store'
import { drain } from '@/lib/sync/drain'
import { reconcile } from '@/lib/sync/reconcile'
import { computeSignature, verifySignature, isPageEvent, isSchemaEvent, pageIdFromEvent } from '@/lib/sync/webhook'
import type { SyncStore } from '@/lib/sync/store'

const ITEMS_DS = 'ds-items'
const LOCATIONS_DS = 'ds-locations'

let db: TestDb
let store: SyncStore
let notion: FakeNotion
let householdId: string
let containerId: string

beforeEach(async () => {
  db = await freshDb()
  notion = new FakeNotion()
  store = pgliteSyncStore(db)
  notion.setClock((await db.query<{ n: string }>(`select now() n`)).rows[0].n)

  const seed = await seedHousehold(db, 'rec@example.com')
  householdId = seed.householdId
  const z = await db.query<{ id: string }>(
    `insert into zones (floor_id,name,polygon) values ($1,'Pantry','[[0,0],[1,0],[1,1]]') returning id`,
    [seed.floorId] as never[])
  const s = await db.query<{ id: string }>(
    `insert into shelves (zone_id,name,row_index) values ($1,'Shelf 3',0) returning id`,
    [z.rows[0].id] as never[])
  const c = await db.query<{ id: string }>(
    `insert into containers (shelf_id,label,col_start,col_span) values ($1,'Bin F2a',0,6) returning id`,
    [s.rows[0].id] as never[])
  containerId = c.rows[0].id
  await db.query(`delete from sync_jobs`)
})

afterEach(async () => { await db.close() })

const recDeps = () => ({ store, api: notion, householdId, itemsDataSourceId: ITEMS_DS })
const drainDeps = () => ({ store, api: notion, itemsDataSourceId: ITEMS_DS, locationsDataSourceId: LOCATIONS_DS })

describe('reconcile (section 7.6, M7 acceptance)', () => {
  it('with the webhook disabled, the incremental pass picks up every change', async () => {
    for (const name of ['Rice', 'Dried beans', 'Pasta']) {
      await db.query(`insert into items (household_id, container_id, name) values ($1,$2,$3)`,
        [householdId, containerId, name] as never[])
    }
    await drain(drainDeps())

    // Webhook is "disabled": edits happen in Notion with nothing enqueued.
    for (const [, link] of await Promise.all(
      (await db.query<{ notion_page_id: string }>(
        `select notion_page_id from notion_links where entity_type='item'`)).rows
        .map(async (r, i) => [i, r] as const),
    )) {
      notion.humanEdit(link.notion_page_id, { Quantity: { number: 5 } })
    }
    expect(Number((await db.query<{ n: string }>(
      `select count(*) n from sync_jobs where status='queued'`)).rows[0].n)).toBe(0)

    const stats = await reconcile(recDeps(), 'incremental')
    expect(stats.errors).toEqual([])
    expect(stats.outcomes.applied).toBe(3)

    const qty = (await db.query<{ quantity: number }>(
      `select quantity from items order by name`)).rows.map((r) => r.quantity)
    expect(qty).toEqual([5, 5, 5])
  })

  it('is idempotent: a second pass finds nothing new', async () => {
    await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Flour')`,
      [householdId, containerId] as never[])
    await drain(drainDeps())

    const first = await reconcile(recDeps(), 'full')
    const second = await reconcile(recDeps(), 'full')

    expect(second.outcomes.applied ?? 0).toBe(0)
    expect(second.outcomes.created ?? 0).toBe(0)
    expect(first.errors).toEqual([])
    expect(second.errors).toEqual([])
  })

  it('records a high water mark that the next incremental run uses', async () => {
    await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Sugar')`,
      [householdId, containerId] as never[])
    await drain(drainDeps())

    const first = await reconcile(recDeps(), 'incremental')
    expect(first.highWater).toBeTruthy()

    const stored = await store.lastRunHighWater('reconcile:incremental', householdId)
    expect(stored).toBeTruthy()
  })

  it('pages through more rows than one query returns', async () => {
    for (let i = 0; i < 12; i++) {
      await db.query(`insert into items (household_id, container_id, name) values ($1,$2,$3)`,
        [householdId, containerId, `Jar ${i}`] as never[])
    }
    await drain(drainDeps(), 100)

    // Force pagination by shrinking the page size the fake honours.
    const paged = {
      ...recDeps(),
      api: {
        ...notion,
        queryDataSource: (args: Parameters<typeof notion.queryDataSource>[0]) =>
          notion.queryDataSource({ ...args, pageSize: 5 }),
        retrievePage: notion.retrievePage.bind(notion),
        createPage: notion.createPage.bind(notion),
        updatePage: notion.updatePage.bind(notion),
      },
    }
    const stats = await reconcile(paged, 'full')
    expect(stats.scanned).toBeGreaterThanOrEqual(12)
    expect(stats.errors).toEqual([])
  })
})

describe('webhook signature (section 7.5)', () => {
  const token = 'secret_verification_token'
  const body = JSON.stringify({ type: 'page.properties_updated', entity: { id: 'page-1', type: 'page' } })

  it('accepts a correctly signed body', () => {
    expect(verifySignature(body, computeSignature(body, token), token)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const sig = computeSignature(body, token)
    expect(verifySignature(body + ' ', sig, token)).toBe(false)
  })

  it('rejects the wrong token', () => {
    expect(verifySignature(body, computeSignature(body, 'other'), token)).toBe(false)
  })

  it('rejects a missing signature or missing token', () => {
    expect(verifySignature(body, null, token)).toBe(false)
    expect(verifySignature(body, computeSignature(body, token), null)).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    expect(() => verifySignature(body, 'sha256=deadbeef', token)).not.toThrow()
    expect(verifySignature(body, 'sha256=deadbeef', token)).toBe(false)
  })

  it('classifies events', () => {
    expect(isPageEvent('page.created')).toBe(true)
    expect(isPageEvent('page.properties_updated')).toBe(true)
    expect(isPageEvent('comment.created')).toBe(false)
    expect(isSchemaEvent('data_source.schema_updated')).toBe(true)
    expect(pageIdFromEvent({ entity: { id: 'page-9', type: 'page' } })).toBe('page-9')
    expect(pageIdFromEvent({ entity: { id: 'db-1', type: 'database' } })).toBeNull()
    expect(pageIdFromEvent({})).toBeNull()
  })
})
