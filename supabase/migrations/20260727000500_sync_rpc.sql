-- Sync worker RPCs
-- Spec: handoff sections 7.4, 7.5

-- Section 7.4 step 1: claim up to `lim` ready jobs with `for update skip locked`,
-- so two concurrent drains never process the same job.
set search_path = storage_tracker, extensions, public;

create or replace function claim_sync_jobs(lim int default 25)
returns table (
  id text, household_id uuid, direction sync_direction, entity_type sync_entity,
  entity_id uuid, notion_page_id text, op text, attempts int
)
language plpgsql
set search_path = storage_tracker, extensions, public, pg_temp as $$
begin
  return query
  with claimed as (
    select j.id from sync_jobs j
    where j.status = 'queued' and j.run_after <= now()
    order by j.id
    limit greatest(1, least(lim, 100))
    for update skip locked
  )
  update sync_jobs j
     set status = 'running', attempts = j.attempts + 1
    from claimed
   where j.id = claimed.id
  returning j.id::text, j.household_id, j.direction, j.entity_type,
            j.entity_id, j.notion_page_id, j.op, j.attempts;
end $$;

-- Flattened container context for the Notion location row, section 7.3.
create or replace function container_context(c uuid)
returns table (
  id uuid, household_id uuid, label text, kind text, zone_name text, shelf_name text
)
language sql stable
set search_path = storage_tracker, extensions, public, pg_temp as $$
  select c2.id, homes.household_id, c2.label, c2.kind::text, z.name, s.name
  from containers c2
  join shelves s on s.id = c2.shelf_id
  join zones z on z.id = s.zone_id
  join floors f on f.id = z.floor_id
  join homes on homes.id = f.home_id
  where c2.id = c;
$$;

-- Section 7.5 step 5: apply an inbound change inside a transaction that
-- suppresses the outbound trigger. `set local` is scoped to this function's
-- transaction, so there is nothing to reset afterwards.
create or replace function apply_inbound_item(
  p_item_id uuid,
  p_household_id uuid,
  p_values jsonb,
  p_insert boolean default false
) returns uuid
language plpgsql
set search_path = storage_tracker, extensions, public, pg_temp as $$
declare
  result uuid;
begin
  perform set_config('app.sync_context', 'notion', true);

  if p_insert then
    insert into items (
      household_id, container_id, name, quantity, category, tags, notes,
      deleted_at, last_write_source
    ) values (
      p_household_id,
      nullif(p_values->>'container_id','')::uuid,
      coalesce(p_values->>'name', 'Untitled'),
      coalesce((p_values->>'quantity')::int, 1),
      nullif(p_values->>'category',''),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(p_values->'tags')),
        '{}'::text[]
      ),
      nullif(p_values->>'notes',''),
      nullif(p_values->>'deleted_at','')::timestamptz,
      'notion'
    ) returning id into result;
  else
    update items set
      container_id = case when p_values ? 'container_id'
                          then nullif(p_values->>'container_id','')::uuid
                          else container_id end,
      name = coalesce(p_values->>'name', name),
      quantity = coalesce((p_values->>'quantity')::int, quantity),
      category = case when p_values ? 'category' then nullif(p_values->>'category','') else category end,
      tags = case when p_values ? 'tags' then coalesce(
               (select array_agg(value::text) from jsonb_array_elements_text(p_values->'tags')),
               '{}'::text[]) else tags end,
      notes = case when p_values ? 'notes' then nullif(p_values->>'notes','') else notes end,
      deleted_at = case when p_values ? 'deleted_at'
                        then nullif(p_values->>'deleted_at','')::timestamptz
                        else deleted_at end,
      last_write_source = 'notion'
    where id = p_item_id
    returning id into result;
  end if;

  return result;
end $$;

-- Section 7.5: a Notion row with no Location lands in a lazily created
-- "Unsorted" container, and the plan view shows a badge for it.
create or replace function ensure_unsorted_container(h uuid)
returns uuid
language plpgsql
set search_path = storage_tracker, extensions, public, pg_temp as $$
declare
  target_shelf uuid;
  target_zone uuid;
  target_floor uuid;
  existing uuid;
  next_col int;
begin
  select c.id into existing
  from containers c
  join shelves s on s.id = c.shelf_id
  join zones z on z.id = s.zone_id
  join floors f on f.id = z.floor_id
  join homes on homes.id = f.home_id
  where homes.household_id = h and c.label = 'Unsorted'
  limit 1;
  if existing is not null then
    return existing;
  end if;

  select f.id into target_floor
  from floors f join homes on homes.id = f.home_id
  where homes.household_id = h
  order by f.sort_order limit 1;
  if target_floor is null then
    raise exception 'household % has no floor', h;
  end if;

  select id into target_zone from zones
  where floor_id = target_floor and name = 'Unsorted' limit 1;
  if target_zone is null then
    insert into zones (floor_id, name, room_label, polygon, grid_cols, sort_order)
    values (target_floor, 'Unsorted', 'Inbox', '[[0.01,0.01],[0.09,0.01],[0.09,0.09],[0.01,0.09]]', 12, 999)
    returning id into target_zone;
  end if;

  select id into target_shelf from shelves
  where zone_id = target_zone and row_index = 0;
  if target_shelf is null then
    insert into shelves (zone_id, name, row_index) values (target_zone, 'Inbox', 0)
    returning id into target_shelf;
  end if;

  select coalesce(max(col_start + col_span), 0) into next_col
  from containers where shelf_id = target_shelf;

  insert into containers (shelf_id, label, kind, col_start, col_span, sort_order)
  values (target_shelf, 'Unsorted', 'other', least(next_col, 11), 12 - least(next_col, 11), 999)
  returning id into existing;

  return existing;
end $$;

grant execute on function container_context(uuid) to authenticated;
