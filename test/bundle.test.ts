import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { AUTH_STUB } from './pg'

/**
 * The bundle from scripts/bundle-migrations.mjs is pasted by hand into the SQL
 * editor of a Supabase project that other apps also live in. It gets applied
 * exactly once, against production, with no undo.
 *
 * So it is worth proving that the concatenation itself is valid — the
 * individual migrations passing does not prove that the single-transaction
 * version does, because transaction semantics and statement ordering only exist
 * once they are glued together.
 */
describe('SQL bundle', () => {
  const bundle = () =>
    execFileSync('node', ['scripts/bundle-migrations.mjs'], { encoding: 'utf8' })

  it('includes every migration, in order', async () => {
    const files = (await readdir('supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
    const sql = bundle()
    let cursor = -1
    for (const f of files) {
      const at = sql.indexOf(f)
      expect(at, `${f} missing from bundle`).toBeGreaterThan(-1)
      expect(at, `${f} out of order`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('is wrapped in a single transaction, so a failure leaves nothing behind', () => {
    const sql = bundle()
    // The first executable line, ignoring the generated comment header.
    const first = sql.split('\n')
      .find((l) => l.trim() && !l.trim().startsWith('--'))
    expect(first?.trim()).toBe('begin;')
    expect(sql.trimEnd().endsWith('commit;')).toBe(true)
    // Exactly one transaction. plpgsql bodies contain bare `begin`, which is a
    // block opener and not a transaction, so anchor on the semicolon.
    expect(sql.match(/^begin;$/gm)).toHaveLength(1)
    expect(sql.match(/^commit;$/gm)).toHaveLength(1)
  })

  it('applies cleanly to a fresh database', async () => {
    const db = await PGlite.create({ extensions: { btree_gist, pg_trgm, pgcrypto } })
    await db.exec(AUTH_STUB)
    await db.exec(bundle())

    const { rows } = await db.query<{ n: string }>(
      `select count(*) n from information_schema.tables where table_schema = 'storage_tracker'`)
    expect(Number(rows[0].n)).toBeGreaterThan(10)
    await db.close()
  })

  it('records every version in the migration ledger', async () => {
    const db = await PGlite.create({ extensions: { btree_gist, pg_trgm, pgcrypto } })
    await db.exec(AUTH_STUB)
    await db.exec(bundle())

    const files = (await readdir('supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
    const { rows } = await db.query<{ version: string }>(
      `select version from supabase_migrations.schema_migrations order by version`)
    expect(rows.map((r) => r.version)).toEqual(files.map((f) => f.split('_')[0]))
    await db.close()
  })

  it('is idempotent enough to re-run without duplicating ledger rows', async () => {
    const db = await PGlite.create({ extensions: { btree_gist, pg_trgm, pgcrypto } })
    await db.exec(AUTH_STUB)
    await db.exec(bundle())
    const before = await db.query<{ n: string }>(
      `select count(*) n from supabase_migrations.schema_migrations`)

    // A second full run must not silently double the ledger. It fails on the
    // duplicate object, which is the correct loud outcome, and nothing commits.
    await expect(db.exec(bundle())).rejects.toThrow()
    // The failed statement leaves the transaction aborted; end it before
    // querying, exactly as the SQL editor would on the next run.
    await db.exec('rollback;')

    const after = await db.query<{ n: string }>(
      `select count(*) n from supabase_migrations.schema_migrations`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
    await db.close()
  })

  it('leaves the editor session search_path alone', () => {
    expect(bundle()).toContain('reset search_path;')
  })
})
