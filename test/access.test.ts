import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshDb, type TestDb } from './pg'

/**
 * Invite-only access. The app is public so strangers can try the demo, but
 * bootstrap_household is the gate on who gets an account.
 */
describe('access control', () => {
  let db: TestDb

  const newUser = async (email: string) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`, [email] as never[])
    return rows[0].id
  }

  const bootstrap = (userId: string, email: string) =>
    db.asUser(userId, async () =>
      (await db.query<{ bootstrap_household: string }>(
        `select bootstrap_household('Home')`)).rows[0].bootstrap_household, email)

  beforeEach(async () => { db = await freshDb() })
  afterEach(async () => { await db.close() })

  it('lets a seeded address in', async () => {
    const id = await newUser('beamer408@gmail.com')
    await expect(bootstrap(id, 'beamer408@gmail.com')).resolves.toBeTruthy()
  })

  it('turns a stranger away', async () => {
    const id = await newUser('stranger@example.com')
    await expect(bootstrap(id, 'stranger@example.com')).rejects.toThrow(/NOT_INVITED/)
  })

  it('creates nothing at all for a stranger', async () => {
    const id = await newUser('stranger@example.com')
    await bootstrap(id, 'stranger@example.com').catch(() => {})
    for (const t of ['households', 'household_members', 'homes', 'floors']) {
      const { rows } = await db.query<{ n: string }>(`select count(*) n from ${t}`)
      expect(Number(rows[0].n), `${t} should be empty`).toBe(0)
    }
  })

  it('matches case-insensitively and ignores stray whitespace', async () => {
    await db.query(`insert into allowed_emails (email) values ('  Partner@Example.com ')`)
    const id = await newUser('partner@example.com')
    await expect(bootstrap(id, 'partner@example.com')).resolves.toBeTruthy()
  })

  it('rejects a session with no email claim', async () => {
    const id = await newUser('nobody@example.com')
    await expect(bootstrap(id, '')).rejects.toThrow(/NOT_INVITED/)
  })

  it('is idempotent, and does not re-check the allowlist for an existing member', async () => {
    const id = await newUser('beamer408@gmail.com')
    const first = await bootstrap(id, 'beamer408@gmail.com')

    // Revoking the invite must not orphan someone who is already set up.
    await db.query(`delete from allowed_emails`)
    const second = await bootstrap(id, 'beamer408@gmail.com')
    expect(second).toBe(first)
  })

  it('hides the allowlist from signed in users', async () => {
    const id = await newUser('beamer408@gmail.com')
    await bootstrap(id, 'beamer408@gmail.com')
    await db.asUser(id, async () => {
      await expect(db.query(`select * from allowed_emails`)).rejects.toThrow(/permission denied/i)
    }, 'beamer408@gmail.com')
  })
})

describe('access requests', () => {
  let db: TestDb
  beforeEach(async () => { db = await freshDb() })
  afterEach(async () => { await db.close() })

  it('lets an anonymous visitor ask, but never read the queue', async () => {
    await db.exec(`set role anon;`)
    await expect(db.query(
      `insert into access_requests (email, note) values ('curious@example.com','looks useful')`),
    ).resolves.toBeTruthy()

    // Insert-only: they must not be able to enumerate who else asked.
    await expect(db.query(`select * from access_requests`)).rejects.toThrow(/permission denied/i)
    await db.exec(`reset role;`)
  })

  it('lets a member read the queue and approve, which grants access', async () => {
    const owner = (await db.query<{ id: string }>(
      `insert into auth.users (email) values ('beamer408@gmail.com') returning id`)).rows[0].id
    await db.asUser(owner, async () => {
      await db.query(`select bootstrap_household('Home')`)
    }, 'beamer408@gmail.com')

    await db.query(
      `insert into access_requests (email, note) values ('curious@example.com','please')`)

    const reqId = await db.asUser(owner, async () => {
      const { rows } = await db.query<{ id: string; email: string }>(
        `select id, email from access_requests where status = 'pending'`)
      expect(rows).toHaveLength(1)
      return rows[0].id
    }, 'beamer408@gmail.com')

    await db.asUser(owner, async () => {
      await db.query(`select approve_access_request($1)`, [reqId] as never[])
    }, 'beamer408@gmail.com')

    // The approved address can now bootstrap.
    const guest = (await db.query<{ id: string }>(
      `insert into auth.users (email) values ('curious@example.com') returning id`)).rows[0].id
    await expect(db.asUser(guest, async () =>
      (await db.query(`select bootstrap_household('Home')`)).rows[0],
    'curious@example.com')).resolves.toBeTruthy()
  })

  // security definer would otherwise let any signed-in user grant themselves access.
  it('refuses approval from someone who is not a member', async () => {
    await db.query(`insert into access_requests (email) values ('curious@example.com')`)
    const { rows } = await db.query<{ id: string }>(`select id from access_requests`)
    const outsider = (await db.query<{ id: string }>(
      `insert into auth.users (email) values ('outsider@example.com') returning id`)).rows[0].id

    await expect(db.asUser(outsider, async () =>
      db.query(`select approve_access_request($1)`, [rows[0].id] as never[]),
    'outsider@example.com')).rejects.toThrow(/not permitted/)
  })

  it('keeps only one pending request per address', async () => {
    await db.query(`insert into access_requests (email) values ('curious@example.com')`)
    await expect(db.query(
      `insert into access_requests (email) values ('Curious@example.com')`),
    ).rejects.toThrow()
  })
})
