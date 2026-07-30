-- Invite-only access, with a request queue
--
-- The app is deployed publicly so strangers can try the demo, but signing in
-- and getting a household is invite only. RLS already isolates households from
-- each other; this is about who gets an account at all, and about not handing
-- out storage quota on a project shared with other apps.

set search_path = storage_tracker, extensions, public;

create table allowed_emails (
  email text primary key,
  note text,
  added_at timestamptz not null default now()
);

create table access_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  note text,
  -- 'pending' | 'approved' | 'declined'
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (status in ('pending','approved','declined'))
);

create unique index access_requests_pending_email
  on access_requests (lower(email)) where status = 'pending';

alter table allowed_emails  enable row level security;
alter table access_requests enable row level security;

/*
  allowed_emails gets NO policy: it is a list of real people's addresses, and
  only the security definer bootstrap function (and the service role) has any
  business reading it.
*/
revoke all on allowed_emails from anon, authenticated;

/*
  A stranger must be able to ASK for access without being able to read who else
  has. Insert only, for both anon and authenticated — the latter because a
  signed-in-but-not-invited user lands on the same form.

  No select policy exists, so the blanket grant from the RLS migration cannot
  leak the queue; the explicit revoke makes that independent of RLS too.
*/
revoke all on access_requests from anon, authenticated;
grant insert on access_requests to anon, authenticated;

create policy access_requests_insert on access_requests
  for insert to anon, authenticated with check (true);

/*
  The gate itself. Note this replaces the function from 20260727000400; the
  signature is unchanged so nothing else has to move.

  Case and whitespace are normalised on both sides: an invite typed as
  "Brian@Example.com " must still match a login of "brian@example.com".
*/
create or replace function bootstrap_household(household_name text)
returns uuid language plpgsql security definer
set search_path = storage_tracker, extensions, public, pg_temp as $$
declare
  uid uuid := auth.uid();
  addr text := lower(btrim(coalesce(auth.email(), '')));
  hh uuid;
  hm uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- Already a member: never re-check the allowlist, or removing an address
  -- would orphan an existing household rather than just blocking new ones.
  select household_id into hh from household_members where user_id = uid limit 1;
  if hh is not null then
    return hh;
  end if;

  if addr = '' or not exists (
    select 1 from allowed_emails where lower(btrim(email)) = addr
  ) then
    -- Caught in lib/db/server.ts and turned into the request-access screen.
    raise exception 'NOT_INVITED' using errcode = 'insufficient_privilege';
  end if;

  insert into households (name) values (coalesce(nullif(household_name,''), 'Home'))
    returning id into hh;
  insert into household_members (household_id, user_id, role) values (hh, uid, 'owner');
  insert into homes (household_id) values (hh) returning id into hm;
  insert into floors (home_id) values (hm);
  return hh;
end $$;

grant execute on function bootstrap_household(text) to authenticated;

-- Approving a request is one statement, and is also what the settings UI calls.
create or replace function approve_access_request(request_id uuid)
returns void language plpgsql security definer
set search_path = storage_tracker, extensions, public, pg_temp as $$
declare
  addr text;
begin
  -- Only an existing member may approve. Without this, security definer would
  -- let any authenticated user grant access to anyone.
  if not exists (select 1 from household_members where user_id = auth.uid()) then
    raise exception 'not permitted';
  end if;

  select lower(btrim(email)) into addr from access_requests where id = request_id;
  if addr is null then
    raise exception 'no such request';
  end if;

  insert into allowed_emails (email, note)
  values (addr, 'approved from access request')
  on conflict (email) do nothing;

  update access_requests
     set status = 'approved', resolved_at = now()
   where id = request_id;
end $$;

create or replace function decline_access_request(request_id uuid)
returns void language plpgsql security definer
set search_path = storage_tracker, extensions, public, pg_temp as $$
begin
  if not exists (select 1 from household_members where user_id = auth.uid()) then
    raise exception 'not permitted';
  end if;
  update access_requests
     set status = 'declined', resolved_at = now()
   where id = request_id;
end $$;

grant execute on function approve_access_request(uuid) to authenticated;
grant execute on function decline_access_request(uuid) to authenticated;

-- Members can read the queue so the settings page can show it. Reading is
-- separate from the insert-only grant above.
grant select, update on access_requests to authenticated;

create policy access_requests_read on access_requests
  for select to authenticated
  using (exists (select 1 from household_members where user_id = auth.uid()));

-- Seed. Change or extend with:
--   insert into storage_tracker.allowed_emails (email) values ('someone@example.com');
insert into allowed_emails (email, note)
values ('beamer408@gmail.com', 'owner')
on conflict (email) do nothing;
