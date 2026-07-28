import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { DB_SCHEMA } from './constants'

/**
 * Service role client. Bypasses RLS. Section 4.3.
 *
 * This module must never reach a client component. The `server-only` import
 * above turns that into a build error rather than a leaked key.
 */
function build() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    // This app owns a dedicated schema; the project is shared with other apps.
    db: { schema: DB_SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// Inferred rather than annotated: SupabaseClient's default generics pin the
// schema to "public", which no longer describes this client.
export type ServiceClient = ReturnType<typeof build>

let cached: ServiceClient | null = null

export function supabaseService(): ServiceClient {
  if (!cached) cached = build()
  return cached
}
