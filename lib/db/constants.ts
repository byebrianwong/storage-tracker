/**
 * This app shares its Supabase project with other apps, so both of its
 * namespaces are explicit rather than defaulted.
 *
 * DB_SCHEMA must also be listed under Dashboard, API, Exposed schemas, or
 * PostgREST returns 403 for everything regardless of RLS.
 *
 * The bucket id is global to the project, hence the prefix.
 */
export const DB_SCHEMA = 'storage_tracker'
export const PLANS_BUCKET = 'storage-tracker-floorplans'
