import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Service role client. Bypasses RLS. Section 4.3.
 *
 * This module must never reach a client component. The `server-only` import
 * above turns that into a build error rather than a leaked key.
 */
let cached: SupabaseClient | null = null

export function supabaseService(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  if (!cached) {
    cached = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return cached
}
