import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshDb, seedHousehold, type TestDb } from './pg'
import { DB_SCHEMA, PLANS_BUCKET } from '@/lib/db/constants'

describe('migrations', () => {
  let db: TestDb
  beforeAll(async () => { db = await freshDb() })
  afterAll(async () => { await db.close() })

  it('applies every migration cleanly', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = $1 order by table_name`, [DB_SCHEMA] as never[],
    )
    const names = rows.map((r) => r.table_name)
    expect(names).toEqual(expect.arrayContaining([
      'households', 'household_members', 'homes', 'floors', 'zones', 'shelves',
      'containers', 'items', 'notion_config', 'notion_links', 'sync_jobs',
      'sync_conflicts', 'sync_runs',
    ]))
  })

  /*
    The 000N_*.sql files are placeholders for another app's migrations, carried
    only so `supabase db push` sees the local set as a superset of the shared
    ledger. If someone ever fills one in — by pasting the real SQL, or by
    reaching for a free-looking version number for a new migration — this repo
    would either publish another app's schema or apply SQL the shared project
    already ran. Both are silent, so assert the invariant.
  */
  it('keeps the shared-ledger placeholders empty', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const files = (await readdir('supabase/migrations'))
      .filter((f) => /^\d{1,6}_/.test(f) && !/^\d{14}_/.test(f))

    expect(files.length, 'placeholder files vanished').toBeGreaterThan(0)

    for (const f of files) {
      const body = (await readFile(`supabase/migrations/${f}`, 'utf8'))
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('--'))
        .join('')
      expect(body, `${f} must contain no executable SQL`).toBe('')
    }
  })

  it('enables row level security on every table', async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind = 'r' and not c.relrowsecurity`, [DB_SCHEMA] as never[],
    )
    expect(rows.map((r) => r.relname)).toEqual([])
  })
})

describe('container overlap constraint (section 6)', () => {
  let db: TestDb
  let shelfId: string
  beforeAll(async () => {
    db = await freshDb()
    const { floorId } = await seedHousehold(db, 'a@example.com')
    const zone = await db.query<{ id: string }>(
      `insert into zones (floor_id, name, polygon) values ($1, 'Entry closet', '[[0,0],[1,0],[1,1]]')
       returning id`, [floorId],
    )
    const shelf = await db.query<{ id: string }>(
      `insert into shelves (zone_id, name, row_index) values ($1, 'Top shelf', 0) returning id`,
      [zone.rows[0].id],
    )
    shelfId = shelf.rows[0].id
  })
  afterAll(async () => { await db.close() })

  it('accepts adjacent containers', async () => {
    await db.query(
      `insert into containers (shelf_id, label, col_start, col_span) values ($1,'Bin A',0,4)`, [shelfId])
    await expect(db.query(
      `insert into containers (shelf_id, label, col_start, col_span) values ($1,'Bin B',4,4)`, [shelfId]),
    ).resolves.toBeTruthy()
  })

  it('accepts gaps, because a half empty shelf is information', async () => {
    await expect(db.query(
      `insert into containers (shelf_id, label, col_start, col_span) values ($1,'Bin C',9,3)`, [shelfId]),
    ).resolves.toBeTruthy()
  })

  it('rejects an overlap', async () => {
    await expect(db.query(
      `insert into containers (shelf_id, label, col_start, col_span) values ($1,'Bin D',3,4)`, [shelfId]),
    ).rejects.toThrow(/containers_no_overlap/)
  })
})

describe('outbound push trigger (section 4.4)', () => {
  let db: TestDb
  let householdId: string
  let containerId: string

  beforeAll(async () => {
    db = await freshDb()
    const seed = await seedHousehold(db, 'b@example.com')
    householdId = seed.householdId
    const zone = await db.query<{ id: string }>(
      `insert into zones (floor_id, name, polygon) values ($1,'Pantry','[[0,0],[1,0],[1,1]]') returning id`,
      [seed.floorId])
    const shelf = await db.query<{ id: string }>(
      `insert into shelves (zone_id, name, row_index) values ($1,'Shelf 1',0) returning id`,
      [zone.rows[0].id])
    const c = await db.query<{ id: string }>(
      `insert into containers (shelf_id, label, col_start, col_span) values ($1,'Bin F2a',0,6) returning id`,
      [shelf.rows[0].id])
    containerId = c.rows[0].id
    await db.query(`delete from sync_jobs`)
  })
  afterAll(async () => { await db.close() })

  const jobs = async () => (await db.query<{ op: string; entity_type: string }>(
    `select op, entity_type from sync_jobs order by id`)).rows

  it('enqueues an upsert on insert', async () => {
    await db.query(
      `insert into items (household_id, container_id, name) values ($1,$2,'Sleeping bags')`,
      [householdId, containerId])
    expect(await jobs()).toEqual([{ op: 'upsert', entity_type: 'item' }])
  })

  it('enqueues an archive on soft delete', async () => {
    await db.query(`delete from sync_jobs`)
    await db.query(`update items set deleted_at = now() where name = 'Sleeping bags'`)
    expect(await jobs()).toEqual([{ op: 'archive', entity_type: 'item' }])
  })

  // The section 4.4 version reads NEW.household_id unconditionally, which raises
  // "record new is not assigned yet" on any DELETE.
  it('survives a hard delete without raising', async () => {
    await db.query(`delete from sync_jobs`)
    await expect(db.query(`delete from items where name = 'Sleeping bags'`)).resolves.toBeTruthy()
    expect(await jobs()).toEqual([{ op: 'archive', entity_type: 'item' }])
  })

  it('suppresses the push when the write came from Notion', async () => {
    await db.query(`delete from sync_jobs`)
    await db.exec(`
      begin;
        set local app.sync_context = 'notion';
        insert into items (household_id, name, last_write_source)
        values ('${householdId}', 'Pulled from Notion', 'notion');
      commit;`)
    expect(await jobs()).toEqual([])
  })

  it('does not enqueue for an update that changes nothing Notion mirrors', async () => {
    await db.query(`insert into items (household_id, name) values ($1,'Camp stove')`, [householdId])
    await db.query(`delete from sync_jobs`)
    await db.query(`update items set photo_path = 'x.png' where name = 'Camp stove'`)
    expect(await jobs()).toEqual([])
  })

  it('enqueues a container push', async () => {
    await db.query(`delete from sync_jobs`)
    await db.query(`update containers set label = 'Bin F2a renamed' where id = $1`, [containerId])
    expect(await jobs()).toEqual([{ op: 'upsert', entity_type: 'container' }])
  })
})

// M1 acceptance: two accounts in the same household see the same data,
// an account outside it gets zero rows from a direct query.
describe('RLS isolation (M1 acceptance)', () => {
  let db: TestDb
  beforeAll(async () => { db = await freshDb() })
  afterAll(async () => { await db.close() })

  it('shares data inside a household and hides it outside', async () => {
    const alice = await seedHousehold(db, 'alice@example.com')
    const bob = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('bob@example.com') returning id`)
    await db.query(`insert into household_members (household_id, user_id) values ($1,$2)`,
      [alice.householdId, bob.rows[0].id])
    const outsider = await seedHousehold(db, 'mallory@example.com')

    await db.query(`insert into items (household_id, name) values ($1,'Passports')`, [alice.householdId])
    await db.query(`grant select, insert, update on all tables in schema storage_tracker to authenticated`)

    const count = async (uid: string) => db.asUser(uid, async () =>
      Number((await db.query<{ n: string }>(`select count(*) n from items`)).rows[0].n))

    expect(await count(alice.userId)).toBe(1)
    expect(await count(bob.rows[0].id)).toBe(1)
    expect(await count(outsider.userId)).toBe(0)
  })

  // The webhook verification token is the HMAC key for every Notion delivery.
  // Only the service role should ever read it.
  it('hides the webhook verification token from signed in users', async () => {
    const dave = await seedHousehold(db, 'dave@example.com')
    await db.query(
      `insert into notion_config (household_id, items_database_id) values ($1, 'db-1')`,
      [dave.householdId] as never[])
    await db.query(
      `insert into notion_secrets (household_id, webhook_verification_token)
       values ($1, 'super-secret')`, [dave.householdId] as never[])

    // Deliberately hostile: hand `authenticated` every grant there is. RLS with
    // no policy must still return nothing, which a column level revoke would not
    // have achieved because column privileges cannot subtract from a table grant.
    await db.query(`grant all on all tables in schema storage_tracker to authenticated`)

    await db.asUser(dave.userId, async () => {
      const config = await db.query<{ items_database_id: string }>(
        `select items_database_id from notion_config`)
      expect(config.rows[0].items_database_id).toBe('db-1')

      const secrets = await db.query(`select * from notion_secrets`)
      expect(secrets.rows).toEqual([])
    })
  })

  // Section 5.1: the bucket is private. Objects live at {home_id}/{floor_id},
  // so the first path segment is the whole authorization decision.
  it('scopes floor plan objects to the owning household', async () => {
    const erin = await seedHousehold(db, 'erin@example.com')
    const frank = await seedHousehold(db, 'frank@example.com')
    await db.query(
      `insert into storage.objects (bucket_id, name) values ($1, $2)`,
      [PLANS_BUCKET, `${erin.homeId}/${erin.floorId}.png`] as never[])
    await db.query(`grant all on all tables in schema storage to authenticated`)

    const visible = async (uid: string) => db.asUser(uid, async () =>
      Number((await db.query<{ n: string }>(
        `select count(*) n from storage.objects`)).rows[0].n))

    expect(await visible(erin.userId)).toBe(1)
    expect(await visible(frank.userId)).toBe(0)
  })

  it('keeps the plans bucket private', async () => {
    const { rows } = await db.query<{ public: boolean }>(
      `select public from storage.buckets where id = $1`, [PLANS_BUCKET] as never[])
    expect(rows[0]?.public).toBe(false)
  })

  it('hides soft deleted items from the select policy', async () => {
    const carol = await seedHousehold(db, 'carol@example.com')
    await db.query(`insert into items (household_id, name, deleted_at) values ($1,'Old thing', now())`,
      [carol.householdId])
    await db.query(`grant select on all tables in schema storage_tracker to authenticated`)
    const n = await db.asUser(carol.userId, async () =>
      Number((await db.query<{ n: string }>(`select count(*) n from items`)).rows[0].n))
    expect(n).toBe(0)
  })
})
