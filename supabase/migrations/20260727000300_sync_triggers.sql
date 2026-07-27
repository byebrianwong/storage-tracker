-- updated_at maintenance and outbound sync enqueueing
-- Spec: handoff section 4.4

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger items_touch before update on items
  for each row execute function touch_updated_at();
create trigger zones_touch before update on zones
  for each row execute function touch_updated_at();
create trigger containers_touch before update on containers
  for each row execute function touch_updated_at();
create trigger notion_config_touch before update on notion_config
  for each row execute function touch_updated_at();

-- Echo suppression, decision 2 in section 13.
--
-- We use the transaction scoped session variable, NOT the last_write_source
-- column. The column approach in section 7.5 step 6 requires a second UPDATE to
-- reset the flag back to 'app', and that reset statement fires this very trigger
-- with last_write_source = 'app', enqueueing exactly the spurious push the
-- mechanism exists to prevent. `set local` is transaction scoped, needs no reset,
-- and cannot leak into the next statement on a pooled connection.
--
-- items.last_write_source is still written by the pull worker, but purely as a
-- human readable audit trail. This trigger does not read it. Do not add a second
-- suppression path here.
create or replace function sync_context() returns text language sql stable as $$
  select coalesce(nullif(current_setting('app.sync_context', true), ''), 'app');
$$;

create or replace function enqueue_item_push() returns trigger language plpgsql as $$
declare
  hh uuid;
  entity uuid;
  operation text;
begin
  -- do not push back what we just pulled
  if sync_context() = 'notion' then
    return null;
  end if;

  -- NEW is unassigned on DELETE, so read the sides explicitly rather than
  -- coalescing across them. The section 4.4 version raises
  -- "record new is not assigned yet" on any delete.
  if tg_op = 'DELETE' then
    hh := old.household_id;
    entity := old.id;
    operation := 'archive';
  else
    hh := new.household_id;
    entity := new.id;
    operation := case when new.deleted_at is not null then 'archive' else 'upsert' end;
  end if;

  -- Skip no-op updates that touched nothing Notion cares about.
  if tg_op = 'UPDATE'
     and old.name is not distinct from new.name
     and old.quantity is not distinct from new.quantity
     and old.category is not distinct from new.category
     and old.tags is not distinct from new.tags
     and old.notes is not distinct from new.notes
     and old.container_id is not distinct from new.container_id
     and old.deleted_at is not distinct from new.deleted_at then
    return null;
  end if;

  insert into sync_jobs (household_id, direction, entity_type, entity_id, op)
  values (hh, 'push', 'item', entity, operation);
  return null;
end $$;

create trigger items_enqueue_push
  after insert or update or delete on items
  for each row execute function enqueue_item_push();

-- Containers need a Notion location row each, section 4.4.
-- Containers carry no household_id, so walk up. During a cascading delete the
-- parent zone may already be gone; in that case we cannot resolve the household
-- and skip the job. The nightly full reconcile reports the orphaned Notion page.
create or replace function container_household(c_shelf uuid)
returns uuid language sql stable as $$
  select homes.household_id
  from shelves
  join zones on zones.id = shelves.zone_id
  join floors on floors.id = zones.floor_id
  join homes on homes.id = floors.home_id
  where shelves.id = c_shelf;
$$;

create or replace function enqueue_container_push() returns trigger language plpgsql as $$
declare
  hh uuid;
  entity uuid;
  operation text;
begin
  if sync_context() = 'notion' then
    return null;
  end if;

  if tg_op = 'DELETE' then
    hh := container_household(old.shelf_id);
    entity := old.id;
    operation := 'archive';
  else
    hh := container_household(new.shelf_id);
    entity := new.id;
    operation := 'upsert';
  end if;

  if hh is null then
    return null;
  end if;

  if tg_op = 'UPDATE'
     and old.label is not distinct from new.label
     and old.kind is not distinct from new.kind
     and old.shelf_id is not distinct from new.shelf_id then
    return null;
  end if;

  insert into sync_jobs (household_id, direction, entity_type, entity_id, op)
  values (hh, 'push', 'container', entity, operation);
  return null;
end $$;

create trigger containers_enqueue_push
  after insert or update or delete on containers
  for each row execute function enqueue_container_push();
