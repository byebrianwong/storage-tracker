-- Realtime publication
-- Spec: handoff section 2, "Supabase Realtime on items and containers, drives
-- live update when Notion sync writes".
--
-- Subscribing in the client is only half of it: a table emits nothing until it
-- is a member of the supabase_realtime publication. That is normally a click in
-- the dashboard, which is easy to forget and fails silently — the subscription
-- connects, no error is raised, and events simply never arrive.
--
-- Guarded so the same migration applies to a bare Postgres (the PGlite test
-- harness), where the publication does not exist.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'storage_tracker' and tablename = 'items'
    ) then
      execute 'alter publication supabase_realtime add table storage_tracker.items';
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'storage_tracker' and tablename = 'containers'
    ) then
      execute 'alter publication supabase_realtime add table storage_tracker.containers';
    end if;
  end if;
end $$;
