'use client'
import { createBrowserClient } from '@supabase/ssr'
import { DB_SCHEMA } from './constants'

let cached: ReturnType<typeof createBrowserClient> | null = null

/** Browser client, used for auth and for the Realtime subscriptions in section 2. */
export function supabaseBrowser() {
  if (!cached) {
    cached = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { db: { schema: DB_SCHEMA } },
    )
  }
  return cached
}
