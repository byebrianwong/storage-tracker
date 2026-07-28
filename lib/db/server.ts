import 'server-only'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { DB_SCHEMA } from './constants'

/** Request scoped Supabase client that carries the user's session. RLS applies. */
export async function supabaseServer() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: DB_SCHEMA },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // Called from a Server Component, where cookies are read only.
            // Middleware refreshes the session, so this is safe to swallow.
          }
        },
      },
    },
  )
}

export async function requireUser() {
  const supabase = await supabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')
  return user
}

/**
 * The household the signed in user belongs to, creating one on first login.
 * Two users, invite by email, so a user belongs to exactly one household in v1.
 */
export async function currentHousehold() {
  const supabase = await supabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: membership } = await supabase
    .from('household_members')
    .select('household_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (membership) return membership.household_id as string

  // First login: bootstrap household, home and floor in one round trip.
  const { data, error } = await supabase.rpc('bootstrap_household', {
    household_name: user.email ?? 'Home',
  })
  if (error) throw error
  return data as string
}
