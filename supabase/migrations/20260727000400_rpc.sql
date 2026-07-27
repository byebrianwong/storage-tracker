-- Application RPCs: household bootstrap and ranked search
-- Spec: handoff sections 1 (household on first login) and 8 (search)

-- Create a household, home and floor for a brand new user, and enrol them.
-- security definer because the caller has no household yet, so no policy can
-- admit the inserts.
create or replace function bootstrap_household(household_name text)
returns uuid language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  hh uuid;
  hm uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select household_id into hh from household_members where user_id = uid limit 1;
  if hh is not null then
    return hh;
  end if;

  insert into households (name) values (coalesce(nullif(household_name,''), 'Home'))
    returning id into hh;
  insert into household_members (household_id, user_id, role) values (hh, uid, 'owner');
  insert into homes (household_id) values (hh) returning id into hm;
  insert into floors (home_id) values (hm);
  return hh;
end $$;

-- Section 8 ranking: exact name match, then prefix, then full text rank, then
-- trigram similarity. A match on the container label or zone name also counts,
-- at lower weight, so "pantry" surfaces everything in the pantry.
create or replace function search_items(q text, lim int default 25)
returns table (
  item_id uuid,
  name text,
  quantity int,
  category text,
  rank real,
  zone_id uuid,
  zone_name text,
  shelf_name text,
  container_id uuid,
  container_label text
)
language sql stable
set search_path = public, pg_temp as $$
  with needle as (
    select lower(btrim(q)) as t,
           websearch_to_tsquery('english', btrim(q)) as tsq
  )
  select
    i.id,
    i.name,
    i.quantity,
    i.category,
    (
      case when lower(i.name) = n.t then 1.0
           when lower(i.name) like n.t || '%' then 0.8
           when lower(i.name) like '%' || n.t || '%' then 0.6
           else 0.0 end
      + case when n.tsq is not null and i.search_tsv @@ n.tsq
             then 0.4 + ts_rank(i.search_tsv, n.tsq) else 0.0 end
      + similarity(lower(i.name), n.t) * 0.3
      + case when lower(coalesce(c.label,'')) like '%' || n.t || '%'
              or lower(coalesce(z.name,''))  like '%' || n.t || '%'
              or lower(coalesce(s.name,''))  like '%' || n.t || '%'
             then 0.25 else 0.0 end
    )::real as rank,
    z.id, z.name, s.name, c.id, c.label
  from items i
  cross join needle n
  left join containers c on c.id = i.container_id
  left join shelves s on s.id = c.shelf_id
  left join zones z on z.id = s.zone_id
  where i.deleted_at is null
    and n.t <> ''
    and (
      i.search_tsv @@ n.tsq
      or lower(i.name) like '%' || n.t || '%'
      -- typo tolerance, section 8. 0.25 is loose enough to catch a
      -- transposition in a short word without returning the whole table.
      or similarity(lower(i.name), n.t) > 0.25
      or lower(coalesce(c.label,'')) like '%' || n.t || '%'
      or lower(coalesce(z.name,''))  like '%' || n.t || '%'
      or lower(coalesce(s.name,''))  like '%' || n.t || '%'
    )
  order by rank desc, i.name asc
  limit greatest(1, least(lim, 100));
$$;

-- Item counts per container, for the elevation view and the plan hover count.
create or replace function container_item_counts(zone uuid)
returns table (container_id uuid, item_count bigint)
language sql stable
set search_path = public, pg_temp as $$
  select c.id, count(i.id)
  from containers c
  join shelves s on s.id = c.shelf_id
  left join items i on i.container_id = c.id and i.deleted_at is null
  where s.zone_id = zone
  group by c.id;
$$;

grant execute on function bootstrap_household(text) to authenticated;
grant execute on function search_items(text, int) to authenticated;
grant execute on function container_item_counts(uuid) to authenticated;
