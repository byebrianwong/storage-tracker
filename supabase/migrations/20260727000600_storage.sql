-- Floor plan storage bucket and its policies
-- Spec: handoff section 5.1
--
-- The handoff describes the private `floorplans` bucket but never creates it.
-- Without this, every plan upload fails with a bucket-not-found error.
--
-- Bucket ids are global to the Supabase project, which this app shares with
-- others, so the id is namespaced rather than the bare "floorplans".

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'storage-tracker-floorplans', 'storage-tracker-floorplans', false,
  26214400,  -- 25 MB, matching the cap enforced in the upload route
  array['image/png','image/jpeg','application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Objects are stored at {home_id}/{floor_id}.{ext}, so the first path segment
-- is the home id and storage_tracker.home_is_visible() is the whole authorization check.
-- Reads still go through a signed URL; these policies govern who can mint one
-- and who can write.

drop policy if exists "storage-tracker floorplans read own home" on storage.objects;
create policy "storage-tracker floorplans read own home" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'storage-tracker-floorplans'
    and storage_tracker.home_is_visible(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "storage-tracker floorplans insert own home" on storage.objects;
create policy "storage-tracker floorplans insert own home" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'storage-tracker-floorplans'
    and storage_tracker.home_is_visible(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "storage-tracker floorplans update own home" on storage.objects;
create policy "storage-tracker floorplans update own home" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'storage-tracker-floorplans'
    and storage_tracker.home_is_visible(((storage.foldername(name))[1])::uuid)
  );

-- Replacing a plan with a different format leaves the old object orphaned, so
-- the upload route deletes it. That needs a delete policy.
drop policy if exists "storage-tracker floorplans delete own home" on storage.objects;
create policy "storage-tracker floorplans delete own home" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'storage-tracker-floorplans'
    and storage_tracker.home_is_visible(((storage.foldername(name))[1])::uuid)
  );
