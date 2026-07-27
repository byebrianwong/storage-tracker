import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshDb, seedHousehold, type TestDb } from './pg'
import { FakeNotion, rateLimitError, validationError } from './fakes/notion'
import { pgliteSyncStore } from './fakes/store'
import { drain } from '@/lib/sync/drain'
import { pullPage } from '@/lib/sync/pull'
import { itemToNotionProperties } from '@/lib/notion/mappers'
import type { SyncStore } from '@/lib/sync/store'

/**
 * The sync conformance suite from section 11. These are the tests that matter.
 *
 * Real Postgres (PGlite) with the real triggers and RPCs; only the Notion
 * network is faked. The workers under test are the production ones.
 */

const ITEMS_DS = 'ds-items'
const LOCATIONS_DS = 'ds-locations'

let db: TestDb
let store: SyncStore
let notion: FakeNotion
let householdId: string
let containerId: string

const deps = () => ({ store, api: notion, itemsDataSourceId: ITEMS_DS, locationsDataSourceId: LOCATIONS_DS })
const pullDeps = () => ({ store, api: notion, householdId, itemsDataSourceId: ITEMS_DS })

const queueDepth = async () => Number((await db.query<{ n: string }>(
  `select count(*) n from sync_jobs where status in ('queued','running')`)).rows[0].n)

const itemByName = async (name: string) => (await db.query<{
  id: string; name: string; quantity: number; category: string | null
  deleted_at: string | null; container_id: string | null; last_write_source: string
}>(`select id, name, quantity, category, deleted_at, container_id, last_write_source
    from items where name = $1`, [name] as never[])).rows[0]

/**
 * Force an item's updated_at, bypassing the touch_updated_at trigger, so a test
 * can state "the app edit is definitively newer" instead of racing the clock.
 */
async function forceUpdatedAt(itemId: string, offset: string) {
  await db.exec(`alter table items disable trigger items_touch`)
  await db.query(`update items set updated_at = now() + interval '${offset}' where id = $1`,
    [itemId] as never[])
  await db.exec(`alter table items enable trigger items_touch`)
}

beforeEach(async () => {
  db = await freshDb()
  notion = new FakeNotion()
  store = pgliteSyncStore(db)
  // Align the fake Notion clock with Postgres, see FakeNotion.setClock.
  notion.setClock((await db.query<{ n: string }>(`select now() n`)).rows[0].n)

  const seed = await seedHousehold(db, 'sync@example.com')
  householdId = seed.householdId

  const zone = await db.query<{ id: string }>(
    `insert into zones (floor_id, name, polygon) values ($1,'Entry closet','[[0,0],[1,0],[1,1]]')
     returning id`, [seed.floorId] as never[])
  const shelf = await db.query<{ id: string }>(
    `insert into shelves (zone_id, name, row_index) values ($1,'Top shelf',0) returning id`,
    [zone.rows[0].id] as never[])
  const c = await db.query<{ id: string }>(
    `insert into containers (shelf_id, label, col_start, col_span) values ($1,'Bin A1a',0,4) returning id`,
    [shelf.rows[0].id] as never[])
  containerId = c.rows[0].id

  await db.query(`delete from sync_jobs`)
})

afterEach(async () => { await db.close() })

// ---------------------------------------------------------------- case 1
it('1. app create pushes once, queue drains to zero', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Sleeping bags')`,
    [householdId, containerId] as never[])
  expect(await queueDepth()).toBe(1)

  const stats = await drain(deps())
  expect(stats.pushed).toBe(1)
  expect(await queueDepth()).toBe(0)

  // one location page plus one item page
  expect(notion.pages.size).toBe(2)

  // M5 acceptance: running drain twice changes nothing the second time.
  const before = notion.calls.length
  const second = await drain(deps())
  expect(second.claimed).toBe(0)
  expect(notion.calls.length).toBe(before)
})

// ---------------------------------------------------------------- case 2
it('2. Notion create pulls once, no push is enqueued', async () => {
  const page = await notion.createPage({
    dataSourceId: ITEMS_DS,
    body: {
      properties: itemToNotionProperties(
        { name: 'Camp stove', quantity: 1, category: null, tags: [], notes: null,
          location_page_id: null, archived: false },
        { appId: '', lastSynced: notion.now(), syncStatus: 'Pending' }),
    },
  })
  // A human made this row, so strip the App ID the mapper wrote.
  notion.humanEdit(page.id, { 'App ID': { rich_text: [] } })

  const outcome = await pullPage(pullDeps(), await notion.retrievePage(page.id))
  expect(outcome).toBe('created')

  const item = await itemByName('Camp stove')
  expect(item).toBeTruthy()
  expect(item.last_write_source).toBe('notion')

  // The whole point of echo suppression: the pull must not enqueue a push for
  // the item it just wrote.
  const itemPushes = Number((await db.query<{ n: string }>(
    `select count(*) n from sync_jobs where entity_type='item' and direction='push'`)).rows[0].n)
  expect(itemPushes).toBe(0)

  // The lazily created Unsorted container IS a legitimate new location, so it
  // does enqueue a container push. That is correct, not an echo.
  const containerPushes = Number((await db.query<{ n: string }>(
    `select count(*) n from sync_jobs where entity_type='container'`)).rows[0].n)
  expect(containerPushes).toBe(1)
})

// ---------------------------------------------------------------- case 3
it('3. app edit then webhook echo: the echo is dropped by hash', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Headlamps')`,
    [householdId, containerId] as never[])
  await drain(deps())

  const item = await itemByName('Headlamps')
  const link = await store.getLink('item', item.id)
  const page = await notion.retrievePage(link!.notion_page_id)

  // Notion delivers the very change we just made. Force the timestamp check to
  // miss so we prove the hash check is what catches it.
  const bumped = { ...page, last_edited_time: new Date(Date.parse(page.last_edited_time) + 1000).toISOString() }
  const outcome = await pullPage(pullDeps(), bumped)

  expect(outcome).toBe('dropped_echo_hash')
  expect(await queueDepth()).toBe(0)
})

it('3b. the timestamp check drops an echo the hash would not', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Wool hats')`,
    [householdId, containerId] as never[])
  await drain(deps())
  const item = await itemByName('Wool hats')
  const link = await store.getLink('item', item.id)

  const page = await notion.retrievePage(link!.notion_page_id)
  expect(await pullPage(pullDeps(), page)).toBe('dropped_echo_timestamp')
})

// ---------------------------------------------------------------- case 4
it('4. Notion edit then reconcile: the reconcile finds nothing new', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Rain boots')`,
    [householdId, containerId] as never[])
  await drain(deps())
  const item = await itemByName('Rain boots')
  const link = await store.getLink('item', item.id)

  notion.humanEdit(link!.notion_page_id, { Quantity: { number: 4 } })
  expect(await pullPage(pullDeps(), await notion.retrievePage(link!.notion_page_id))).toBe('applied')
  expect((await itemByName('Rain boots')).quantity).toBe(4)
  expect(await queueDepth()).toBe(0)

  // A second pass over the same page must be a no-op.
  const again = await pullPage(pullDeps(), await notion.retrievePage(link!.notion_page_id))
  expect(['dropped_echo_timestamp', 'dropped_echo_hash']).toContain(again)
  expect(await queueDepth()).toBe(0)
})

// ---------------------------------------------------------------- case 5
it('5. simultaneous edit: one conflict row, newer timestamp wins, no lost field', async () => {
  await db.query(
    `insert into items (household_id, container_id, name, category) values ($1,$2,'Tent','Camping')`,
    [householdId, containerId] as never[])
  await drain(deps())
  const item = await itemByName('Tent')
  const link = await store.getLink('item', item.id)

  // Both sides change after last_synced_at, and Notion's edit is the newer one.
  // Both offsets are forced: with a zero latency fake, the link write and the
  // app edit otherwise land in the same millisecond and the strict `>` in the
  // conflict rule becomes a coin flip.
  await db.query(`update items set quantity = 2 where id = $1`, [item.id] as never[])
  await forceUpdatedAt(item.id, '1 minute')
  notion.advance(5 * 60_000)
  notion.humanEdit(link!.notion_page_id, { Name: { title: [{ type: 'text', text: { content: 'Tent, 4 person' } }] } })

  const outcome = await pullPage(pullDeps(), await notion.retrievePage(link!.notion_page_id))
  expect(outcome).toBe('conflict')

  const conflicts = await db.query<{ n: string }>(`select count(*) n from sync_conflicts`)
  expect(Number(conflicts.rows[0].n)).toBe(1)

  // Notion was newer, so its name won...
  const renamed = await itemByName('Tent, 4 person')
  expect(renamed).toBeTruthy()
  // ...and the category the app had is not lost.
  expect(renamed.category).toBe('Camping')
})

// Regression: the conflict branches did not advance notion_last_edited_time, so
// the next reconcile re-detected the same disagreement and wrote another row.
it('5c. re-scanning a conflicted page does not write a second conflict row', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Duvet')`,
    [householdId, containerId] as never[])
  await drain(deps())
  const item = await itemByName('Duvet')
  const link = await store.getLink('item', item.id)

  await db.query(`update items set quantity = 2 where id = $1`, [item.id] as never[])
  await forceUpdatedAt(item.id, '1 minute')
  notion.advance(5 * 60_000)
  notion.humanEdit(link!.notion_page_id, { Quantity: { number: 8 } })

  expect(await pullPage(pullDeps(), await notion.retrievePage(link!.notion_page_id))).toBe('conflict')

  const count = async () => Number((await db.query<{ n: string }>(
    `select count(*) n from sync_conflicts`)).rows[0].n)
  expect(await count()).toBe(1)

  // The nightly full reconcile sweeps the same page again.
  const again = await pullPage(pullDeps(), await notion.retrievePage(link!.notion_page_id))
  expect(again).not.toBe('conflict')
  expect(await count()).toBe(1)
})

it('5b. when the app is newer, the app value is kept and a conflict is still recorded', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Cooler')`,
    [householdId, containerId] as never[])
  await drain(deps())
  const item = await itemByName('Cooler')
  const link = await store.getLink('item', item.id)

  notion.humanEdit(link!.notion_page_id, { Quantity: { number: 9 } })
  // App edit lands after the Notion one. touch_updated_at would stamp now() over
  // any explicit value, so force it.
  await db.query(`update items set quantity = 3 where id=$1`, [item.id] as never[])
  await forceUpdatedAt(item.id, '10 minutes')

  expect(await pullPage(pullDeps(), await notion.retrievePage(link!.notion_page_id))).toBe('conflict')
  expect((await itemByName('Cooler')).quantity).toBe(3)
  expect(Number((await db.query<{ n: string }>(`select count(*) n from sync_conflicts`)).rows[0].n)).toBe(1)
})

// ---------------------------------------------------------------- case 6
it('6. missed webhook: reconcile catches the change', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Yoga mats')`,
    [householdId, containerId] as never[])
  await drain(deps())
  const item = await itemByName('Yoga mats')
  const link = await store.getLink('item', item.id)

  // Webhook never arrives. Nothing is enqueued.
  notion.humanEdit(link!.notion_page_id, { Quantity: { number: 7 } })
  expect(await queueDepth()).toBe(0)
  expect((await itemByName('Yoga mats')).quantity).toBe(1)

  // The 15 minute incremental reconcile sweeps the data source instead.
  const { pages } = await notion.queryDataSource({ dataSourceId: ITEMS_DS })
  for (const page of pages) await pullPage(pullDeps(), page)

  expect((await itemByName('Yoga mats')).quantity).toBe(7)
})

// ---------------------------------------------------------------- case 7
it('7. 429 response: job requeues with backoff and eventually succeeds', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Board games')`,
    [householdId, containerId] as never[])

  notion.failNext(rateLimitError(1))
  const first = await drain(deps())
  expect(first.retried).toBe(1)
  expect(first.failed).toBe(0)

  const job = (await db.query<{ status: string; attempts: number }>(
    `select status, attempts from sync_jobs order by id limit 1`)).rows[0]
  expect(job.status).toBe('queued')
  expect(job.attempts).toBe(1)

  // run_after is in the future, so an immediate drain claims nothing.
  expect((await drain(deps())).claimed).toBe(0)

  await db.query(`update sync_jobs set run_after = now() - interval '1 second'`)
  expect((await drain(deps())).pushed).toBe(1)
  expect(await queueDepth()).toBe(0)
})

it('7b. a 400 is permanent: no retry, job failed, link marked error', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Label maker')`,
    [householdId, containerId] as never[])

  notion.failNext(validationError('Category is not a property that exists'))
  const stats = await drain(deps())

  expect(stats.failed).toBe(1)
  expect(stats.retried).toBe(0)
  const job = (await db.query<{ status: string; last_error: string }>(
    `select status, last_error from sync_jobs order by id limit 1`)).rows[0]
  expect(job.status).toBe('failed')
  expect(job.last_error).toMatch(/not a property/)
})

// ---------------------------------------------------------------- case 8
it('8. item deleted in app: page archived, link row retained', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Old skis')`,
    [householdId, containerId] as never[])
  await drain(deps())
  const item = await itemByName('Old skis')
  const link = await store.getLink('item', item.id)
  expect(link).toBeTruthy()

  await db.query(`update items set deleted_at = now() where id=$1`, [item.id] as never[])
  const stats = await drain(deps())
  expect(stats.archived).toBe(1)

  expect(notion.pages.get(link!.notion_page_id)?.archived).toBe(true)
  // Link retained, so an un-delete reuses the same page.
  expect(await store.getLink('item', item.id)).toBeTruthy()
})

// ---------------------------------------------------------------- case 9
it('9. page archived in Notion: item soft deleted, not hard deleted', async () => {
  await db.query(`insert into items (household_id, container_id, name) values ($1,$2,'Beach towels')`,
    [householdId, containerId] as never[])
  await drain(deps())
  const item = await itemByName('Beach towels')
  const link = await store.getLink('item', item.id)

  notion.humanArchive(link!.notion_page_id)
  expect(await pullPage(pullDeps(), await notion.retrievePage(link!.notion_page_id))).toBe('archived')

  const row = await itemByName('Beach towels')
  expect(row).toBeTruthy()          // the row still exists
  expect(row.deleted_at).not.toBeNull()
})

// ---------------------------------------------------------------- case 10
it('10. renamed Notion property fails loudly, does not write nulls', async () => {
  await db.query(
    `insert into items (household_id, container_id, name, category) values ($1,$2,'Passports','Docs')`,
    [householdId, containerId] as never[])
  await drain(deps())
  const item = await itemByName('Passports')
  const link = await store.getLink('item', item.id)

  // Someone renames "Quantity" to "Qty" in the Notion UI.
  const page = await notion.retrievePage(link!.notion_page_id)
  const renamed = { ...page, last_edited_time: new Date(Date.parse(page.last_edited_time) + 60_000).toISOString(),
    properties: Object.fromEntries(
      Object.entries(page.properties).map(([k, v]) => (k === 'Quantity' ? ['Qty', v] : [k, v])),
    ) }

  await expect(pullPage(pullDeps(), renamed)).rejects.toThrow(/Quantity/)

  // Nothing was written over.
  const after = await itemByName('Passports')
  expect(after.category).toBe('Docs')
  expect(after.quantity).toBe(1)

  // And the failure is visible in the sync log.
  const linkAfter = await store.getLink('item', item.id)
  expect(linkAfter?.status).toBe('error')
})

// ------------------------------------------------------- unsorted inbox
it('a Notion row with no Location lands in a lazily created Unsorted container', async () => {
  const page = await notion.createPage({
    dataSourceId: ITEMS_DS,
    body: {
      properties: itemToNotionProperties(
        { name: 'Mystery box', quantity: 1, category: null, tags: [], notes: null,
          location_page_id: null, archived: false },
        { appId: '', lastSynced: notion.now(), syncStatus: 'Pending' }),
    },
  })
  notion.humanEdit(page.id, { 'App ID': { rich_text: [] } })

  expect(await pullPage(pullDeps(), await notion.retrievePage(page.id))).toBe('created')

  const row = (await db.query<{ label: string }>(
    `select c.label from items i join containers c on c.id = i.container_id
     where i.name = 'Mystery box'`)).rows[0]
  expect(row.label).toBe('Unsorted')
})

describe('drain concurrency', () => {
  it('two concurrent drains never process the same job', async () => {
    for (let i = 0; i < 6; i++) {
      await db.query(`insert into items (household_id, container_id, name) values ($1,$2,$3)`,
        [householdId, containerId, `Item ${i}`] as never[])
    }
    const [a, b] = await Promise.all([drain(deps()), drain(deps())])
    expect(a.claimed + b.claimed).toBe(6)
    expect(await queueDepth()).toBe(0)
  })
})
