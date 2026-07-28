-- Row level security
-- Spec: handoff section 4.3
-- https://supabase.com/docs/guides/database/postgres/row-level-security

set search_path = storage_tracker, extensions, public;

create or replace function is_household_member(h uuid)
returns boolean language sql stable security definer
set search_path = storage_tracker, extensions, public, pg_temp as $$
  select exists (
    select 1 from household_members
    where household_id = h and user_id = auth.uid()
  );
$$;

-- Walk the ownership chain once, in a security definer function, so the
-- policies below stay readable and the planner sees a single function call
-- instead of a five table join per row.
create or replace function zone_is_visible(z uuid)
returns boolean language sql stable security definer
set search_path = storage_tracker, extensions, public, pg_temp as $$
  select exists (
    select 1
    from zones
    join floors on floors.id = zones.floor_id
    join homes on homes.id = floors.home_id
    join household_members m on m.household_id = homes.household_id
    where zones.id = z and m.user_id = auth.uid()
  );
$$;

create or replace function shelf_is_visible(s uuid)
returns boolean language sql stable security definer
set search_path = storage_tracker, extensions, public, pg_temp as $$
  select exists (
    select 1 from shelves where shelves.id = s and zone_is_visible(shelves.zone_id)
  );
$$;

create or replace function container_is_visible(c uuid)
returns boolean language sql stable security definer
set search_path = storage_tracker, extensions, public, pg_temp as $$
  select exists (
    select 1 from containers where containers.id = c and shelf_is_visible(containers.shelf_id)
  );
$$;

create or replace function floor_is_visible(f uuid)
returns boolean language sql stable security definer
set search_path = storage_tracker, extensions, public, pg_temp as $$
  select exists (
    select 1
    from floors
    join homes on homes.id = floors.home_id
    join household_members m on m.household_id = homes.household_id
    where floors.id = f and m.user_id = auth.uid()
  );
$$;

create or replace function home_is_visible(h uuid)
returns boolean language sql stable security definer
set search_path = storage_tracker, extensions, public, pg_temp as $$
  select exists (
    select 1
    from homes
    join household_members m on m.household_id = homes.household_id
    where homes.id = h and m.user_id = auth.uid()
  );
$$;

alter table households          enable row level security;
alter table household_members   enable row level security;
alter table homes               enable row level security;
alter table floors              enable row level security;
alter table zones               enable row level security;
alter table shelves             enable row level security;
alter table containers          enable row level security;
alter table items               enable row level security;
alter table notion_config       enable row level security;
alter table notion_secrets      enable row level security;
alter table notion_links        enable row level security;
alter table sync_jobs           enable row level security;
alter table sync_conflicts      enable row level security;
alter table sync_runs           enable row level security;

-- households
create policy households_rw on households
  for all using (is_household_member(id)) with check (is_household_member(id));

-- household_members: you can see the roster of a household you belong to.
-- The membership check reads household_members itself, so it goes through the
-- security definer helper to avoid recursive policy evaluation.
create policy household_members_read on household_members
  for select using (is_household_member(household_id));

create policy household_members_write on household_members
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

-- homes
create policy homes_rw on homes
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

-- floors, zones, shelves, containers: join up to the household.
-- Section 4.3 says to measure before denormalizing a household_id onto these.
-- Not denormalized. Revisit with EXPLAIN if the plan view gets slow.
create policy floors_rw on floors
  for all using (home_is_visible(home_id)) with check (home_is_visible(home_id));

create policy zones_rw on zones
  for all using (floor_is_visible(floor_id)) with check (floor_is_visible(floor_id));

create policy shelves_rw on shelves
  for all using (zone_is_visible(zone_id)) with check (zone_is_visible(zone_id));

create policy containers_rw on containers
  for all using (shelf_is_visible(shelf_id)) with check (shelf_is_visible(shelf_id));

-- items: live rows only on read, with a separate policy for the soft delete
create policy items_select on items
  for select using (is_household_member(household_id) and deleted_at is null);

create policy items_insert on items
  for insert with check (is_household_member(household_id));

create policy items_update on items
  for update using (is_household_member(household_id))
  with check (is_household_member(household_id));

-- sync surfaces
create policy notion_config_rw on notion_config
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy notion_links_rw on notion_links
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy sync_jobs_rw on sync_jobs
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy sync_conflicts_rw on sync_conflicts
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy sync_runs_read on sync_runs
  for select using (household_id is null or is_household_member(household_id));

/*
  PostgREST grants.

  Supabase's default grants only cover `public`, so a custom schema is invisible
  to the API until it is granted explicitly AND added to Dashboard, API, Exposed
  schemas. Without both, every request comes back 403 even though the policies
  above are correct.

  Broad table grants plus RLS is the standard Supabase pattern: the grant makes
  the table reachable, the policy decides which rows. `anon` gets nothing in
  practice because every policy goes through is_household_member(), which needs
  auth.uid().
*/
grant usage on schema storage_tracker to anon, authenticated, service_role;

grant all on all tables in schema storage_tracker to anon, authenticated, service_role;
grant all on all sequences in schema storage_tracker to anon, authenticated, service_role;
grant all on all functions in schema storage_tracker to anon, authenticated, service_role;

alter default privileges in schema storage_tracker
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema storage_tracker
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema storage_tracker
  grant all on functions to anon, authenticated, service_role;

-- notion_secrets deliberately gets NO policy. RLS is enabled, so `authenticated`
-- and `anon` see zero rows no matter what table grants exist. Only the service
-- role, which bypasses RLS, can read the webhook HMAC key.
--
-- This revoke MUST stay after the blanket grant above, or the grant re-opens it.
-- Do not "fix" this by adding a policy. See the comment on the table.
revoke all on notion_secrets from authenticated, anon;
