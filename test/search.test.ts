import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshDb, seedHousehold, type TestDb } from './pg'

describe('search_items (M4 acceptance)', () => {
  let db: TestDb
  let householdId: string

  beforeAll(async () => {
    db = await freshDb()
    const seed = await seedHousehold(db, 'search@example.com')
    householdId = seed.householdId

    const mk = async (zoneName: string, shelfName: string, label: string, items: string[]) => {
      const z = await db.query<{ id: string }>(
        `insert into zones (floor_id, name, polygon) values ($1,$2,'[[0,0],[1,0],[1,1]]') returning id`,
        [seed.floorId, zoneName])
      const s = await db.query<{ id: string }>(
        `insert into shelves (zone_id, name, row_index) values ($1,$2,0) returning id`,
        [z.rows[0].id, shelfName])
      const c = await db.query<{ id: string }>(
        `insert into containers (shelf_id, label, col_start, col_span) values ($1,$2,0,6) returning id`,
        [s.rows[0].id, label])
      for (const name of items) {
        await db.query(`insert into items (household_id, container_id, name) values ($1,$2,$3)`,
          [householdId, c.rows[0].id, name])
      }
      return c.rows[0].id
    }

    await mk('Balcony deck box', 'Deck box', 'Left half', ['Sleeping bags', 'Camp stove', 'Headlamps'])
    await mk('Pantry', 'Shelf 3', 'Bin F2a', ['Rice', 'Dried beans', 'Pasta'])
    await mk('Entry closet', 'Top shelf', 'Bin A1a', ['Puffer jackets', 'Wool hats'])
    await db.query(
      `insert into items (household_id, name, category, tags) values ($1,'Tax folders','Docs','{paperwork,irs}')`,
      [householdId])
  })
  afterAll(async () => { await db.close() })

  const search = async (q: string) => (await db.query<{
    name: string; zone_name: string | null; container_label: string | null; rank: number
  }>(`select name, zone_name, container_label, rank from search_items($1)`, [q])).rows

  it('finds an exact item and returns its full location path', async () => {
    const rows = await search('sleeping bags')
    expect(rows[0].name).toBe('Sleeping bags')
    expect(rows[0].zone_name).toBe('Balcony deck box')
    expect(rows[0].container_label).toBe('Left half')
  })

  it('ranks an exact match above a partial one', async () => {
    await db.query(`insert into items (household_id, name) values ($1,'Sleeping bag liner')`, [householdId])
    const rows = await search('sleeping bags')
    expect(rows[0].name).toBe('Sleeping bags')
  })

  // The headline M4 criterion.
  it('still finds a misspelled item name', async () => {
    for (const typo of ['sleping bags', 'campp stove', 'headlmaps']) {
      const rows = await search(typo)
      expect(rows.length, `no hit for "${typo}"`).toBeGreaterThan(0)
    }
    expect((await search('sleping bags'))[0].name).toBe('Sleeping bags')
    expect((await search('campp stove'))[0].name).toBe('Camp stove')
  })

  it('matches a zone name, so "pantry" returns what is in the pantry', async () => {
    const names = (await search('pantry')).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['Rice', 'Dried beans', 'Pasta']))
  })

  it('matches a container label', async () => {
    expect((await search('Bin A1a')).map((r) => r.name))
      .toEqual(expect.arrayContaining(['Puffer jackets', 'Wool hats']))
  })

  it('matches category and tags through the tsvector', async () => {
    expect((await search('irs')).map((r) => r.name)).toContain('Tax folders')
    expect((await search('docs')).map((r) => r.name)).toContain('Tax folders')
  })

  it('excludes soft deleted items', async () => {
    await db.query(`update items set deleted_at = now() where name = 'Pasta'`)
    expect((await search('pasta')).map((r) => r.name)).not.toContain('Pasta')
  })

  it('returns nothing for a blank query', async () => {
    expect(await search('   ')).toEqual([])
  })
})
