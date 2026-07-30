import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const MIGRATIONS = join(process.cwd(), 'supabase/migrations')

/**
 * Supabase provides the `auth` schema. PGlite does not, so stub the two pieces
 * the migrations actually reference: the users table that foreign keys point at,
 * and auth.uid(), which every RLS policy calls.
 *
 * auth.uid() reads a session variable so tests can impersonate a user with
 * `set local request.jwt.claim.sub`, the same shape PostgREST uses.
 */
export const AUTH_STUB = `
  create schema if not exists auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique
  );
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  create or replace function auth.email() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claim.email', true), '');
  $$;
  -- Supabase roles referenced by the grant statements in the RLS migration
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      -- bypassrls mirrors Supabase, where the sync workers rely on it
      create role service_role bypassrls;
    end if;
  end $$;

  -- Supabase Storage, enough of it for the floorplans bucket migration to apply
  -- and for its policies to be exercised.
  create schema if not exists storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id),
    name text not null,
    owner uuid,
    created_at timestamptz not null default now()
  );
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(name text)
  returns text[] language sql immutable as $$
    select string_to_array(regexp_replace(name, '/[^/]*$', ''), '/');
  $$;
  grant usage on schema storage to authenticated, anon;

  -- Supabase's migration ledger, which the SQL bundle writes to.
  create schema if not exists supabase_migrations;
  create table supabase_migrations.schema_migrations (
    version text primary key,
    name text,
    statements text[]
  );
`

export type TestDb = PGlite & {
  /** Run a block as a given user id, with RLS enforced. */
  asUser<T>(userId: string, fn: () => Promise<T>, email?: string): Promise<T>
}

/** A fresh in-memory Postgres with every migration applied, in filename order. */
export async function freshDb(): Promise<TestDb> {
  const db = await PGlite.create({
    extensions: { btree_gist, pg_trgm, pgcrypto },
  })

  await db.exec(AUTH_STUB)

  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()
  if (files.length === 0) throw new Error(`no migrations found in ${MIGRATIONS}`)

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS, file), 'utf8')
    try {
      await db.exec(sql)
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`)
    }
  }

  // The app's objects live in storage_tracker, not public. PostgREST reaches
  // them via the client's `db.schema` option; a raw SQL session needs the
  // search_path instead, so tests can write unqualified table names.
  await db.exec(`set search_path = storage_tracker, extensions, public;`)

  const tdb = db as unknown as TestDb
  tdb.asUser = async (userId, fn, email) => {
    // RLS is bypassed for superusers, which is what PGlite connects as.
    // `set role authenticated` makes the policies actually apply.
    await db.exec(
      `set role authenticated;
       set search_path = storage_tracker, extensions, public;
       select set_config('request.jwt.claim.sub', '${userId}', false);
       select set_config('request.jwt.claim.email', '${email ?? ''}', false);`,
    )
    try {
      return await fn()
    } finally {
      await db.exec(
        `reset role;
         set search_path = storage_tracker, extensions, public;
         select set_config('request.jwt.claim.sub', '', false);
         select set_config('request.jwt.claim.email', '', false);`,
      )
    }
  }
  return tdb
}

/** Create a household with one member and a home/floor, returning the ids. */
export async function seedHousehold(db: PGlite, email: string) {
  const user = await db.query<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`, [email],
  )
  const userId = user.rows[0].id
  const hh = await db.query<{ id: string }>(
    `insert into households (name) values ($1) returning id`, [`${email} household`],
  )
  const householdId = hh.rows[0].id
  await db.query(`insert into household_members (household_id, user_id) values ($1, $2)`, [
    householdId, userId,
  ])
  const home = await db.query<{ id: string }>(
    `insert into homes (household_id) values ($1) returning id`, [householdId],
  )
  const homeId = home.rows[0].id
  const floor = await db.query<{ id: string }>(
    `insert into floors (home_id) values ($1) returning id`, [homeId],
  )
  return { userId, householdId, homeId, floorId: floor.rows[0].id }
}
