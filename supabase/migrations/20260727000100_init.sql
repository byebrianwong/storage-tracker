-- Home storage inventory: core schema
-- Spec: handoff section 4.2

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";
-- required so the containers exclusion constraint can mix `=` on uuid with `&&` on a range
create extension if not exists "btree_gist";

create type container_kind as enum
  ('bin','drawer','box','basket','rod','hook','open_shelf','cabinet','other');

create type sync_entity as enum ('item','container');
create type sync_direction as enum ('push','pull');
create type sync_status as enum ('synced','pending','conflict','error');

create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table household_members (
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  primary key (household_id, user_id)
);

create index household_members_user_idx on household_members(user_id);

create table homes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null default 'Home',
  created_at timestamptz not null default now()
);

create index homes_household_idx on homes(household_id);

create table floors (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references homes(id) on delete cascade,
  name text not null default 'Main floor',
  level int not null default 0,
  -- Supabase Storage object path for the uploaded plan
  plan_path text,
  -- intrinsic pixel size of the rendered plan, used to keep polygons stable
  plan_width int,
  plan_height int,
  sort_order int not null default 0
);

create index floors_home_idx on floors(home_id);

create table zones (
  id uuid primary key default gen_random_uuid(),
  floor_id uuid not null references floors(id) on delete cascade,
  name text not null,                    -- "Entry closet"
  code text,                             -- "A1", optional short label
  room_label text,                       -- "Entry", drawn on the plan
  -- polygon in normalized plan coordinates, [[x,y],...] with x and y in 0..1
  polygon jsonb not null,
  -- label anchor, also normalized: {"x":0.1,"y":0.4,"anchor":"start"}
  label_anchor jsonb,
  -- how many columns the elevation grid uses for this zone
  grid_cols int not null default 12,
  notes text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (grid_cols between 1 and 48)
);

create index zones_floor_idx on zones(floor_id);

create table shelves (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid not null references zones(id) on delete cascade,
  name text not null,                    -- "Top shelf", "Hanging rod", "Floor"
  row_index int not null,                -- 0 is the top row in the drawing
  height_units int not null default 1,   -- relative row height, 1 or 2
  unique (zone_id, row_index),
  check (height_units between 1 and 4)
);

create table containers (
  id uuid primary key default gen_random_uuid(),
  shelf_id uuid not null references shelves(id) on delete cascade,
  label text not null,                   -- "Bin A1a"
  kind container_kind not null default 'bin',
  col_start int not null,                -- 0 based, within zones.grid_cols
  col_span int not null default 1,
  color_tag text,                        -- category color, e.g. "camping"
  notes text,
  -- section 13.4: deferred in the UI, cheap to carry now
  capacity_hint int,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (col_start >= 0 and col_span >= 1)
);

create index containers_shelf_idx on containers(shelf_id);

-- Section 6: overlapping containers on the same shelf are a validation error.
-- Expressed cleanly as an exclusion constraint over the half-open column range,
-- so the database is the backstop and the editor is the friendly message.
alter table containers
  add constraint containers_no_overlap
  exclude using gist (
    shelf_id with =,
    int4range(col_start, col_start + col_span) with &&
  );

create table items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  container_id uuid references containers(id) on delete set null,
  name text not null,
  quantity int not null default 1,
  category text,
  tags text[] not null default '{}',
  notes text,
  photo_path text,
  deleted_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- true when the last write came from the Notion sync, used for echo suppression
  last_write_source text not null default 'app',
  check (quantity >= 0),
  check (last_write_source in ('app','notion'))
);

create index items_container_idx on items(container_id) where deleted_at is null;
create index items_household_idx on items(household_id) where deleted_at is null;

-- full text search, https://supabase.com/docs/guides/database/full-text-search
--
-- array_to_string is STABLE, not IMMUTABLE, because in the general case it
-- depends on the element type's output function. A generated column requires an
-- immutable expression, so the section 4.2 expression is rejected by Postgres
-- with "generation expression is not immutable". The element type here is fixed
-- as text, whose output function is immutable, so this wrapper is sound.
create or replace function immutable_array_to_string(arr text[], sep text)
returns text language sql immutable parallel safe as $$
  select array_to_string(arr, sep);
$$;

alter table items add column search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(name,'') || ' ' || coalesce(category,'') || ' ' ||
      coalesce(immutable_array_to_string(tags,' '),'') || ' ' || coalesce(notes,''))
  ) stored;
create index items_search_idx on items using gin(search_tsv);

-- section 8: trigram index for typo tolerance
create index items_name_trgm_idx on items using gin (name gin_trgm_ops);

-- Notion connection state. Referenced by sections 7.2 and 7.5 but absent from
-- the section 4.2 migration; added here so the data source id and the webhook
-- verification token have somewhere to live.
create table notion_config (
  household_id uuid primary key references households(id) on delete cascade,
  items_database_id text,
  items_data_source_id text,
  locations_database_id text,
  locations_data_source_id text,
  parent_page_id text,
  notion_version text not null default '2025-09-03',
  connected_at timestamptz,
  updated_at timestamptz not null default now()
);

-- The webhook verification token is the HMAC key for every Notion delivery, so
-- it lives in its own table rather than as a column on notion_config.
--
-- A column level `revoke select (col)` does NOT work here: Postgres column
-- privileges are additive to table privileges, and Supabase grants table wide
-- select to `authenticated` by default, so the revoke is silently a no op and
-- any signed in user can read the key. Isolating it in a table that has RLS
-- enabled and no policy at all means non service-role clients get zero rows,
-- and it stays that way even if someone re-runs a blanket grant later.
create table notion_secrets (
  household_id uuid primary key references households(id) on delete cascade,
  webhook_verification_token text,
  updated_at timestamptz not null default now()
);

create table notion_links (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  entity_type sync_entity not null,
  entity_id uuid not null,
  notion_page_id text not null,
  notion_data_source_id text not null,
  -- last_edited_time of the page as of our last successful push or pull
  notion_last_edited_time timestamptz,
  -- hash of the normalized payload we last pushed, used to drop echo events
  last_pushed_hash text,
  last_synced_at timestamptz,
  status sync_status not null default 'pending',
  error text,
  unique (entity_type, entity_id),
  unique (notion_page_id)
);

create index notion_links_household_idx on notion_links(household_id);

create table sync_jobs (
  id bigserial primary key,
  household_id uuid not null references households(id) on delete cascade,
  direction sync_direction not null,
  entity_type sync_entity not null,
  entity_id uuid,
  notion_page_id text,
  op text not null,                      -- 'upsert' | 'archive'
  status text not null default 'queued', -- queued | running | done | failed
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);
create index sync_jobs_ready_idx on sync_jobs(status, run_after);

create table sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  item_id uuid references items(id) on delete cascade,
  app_value jsonb not null,
  notion_value jsonb not null,
  resolved_as text,                      -- 'app' | 'notion' | 'manual'
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index sync_conflicts_open_idx on sync_conflicts(household_id) where resolved_at is null;

create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete cascade,
  kind text not null,                    -- 'drain' | 'reconcile' | 'webhook'
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- incremental reconcile watermark, section 7.6
  cursor_high_water timestamptz,
  ok boolean,
  stats jsonb
);

create index sync_runs_recent_idx on sync_runs(kind, started_at desc);
