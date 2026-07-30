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
 * Three distinct states, not two. "Signed in but not invited" is a real
 * outcome and needs its own screen: bouncing such a user to /login would
 * loop, because they are authenticated and /login sends them back to /plan.
 */
export type HouseholdResult =
  | { status: 'ok'; householdId: string }
  | { status: 'anonymous' }
  | { status: 'not_invited'; email: string | null }

export async function currentHousehold(): Promise<HouseholdResult> {
  const supabase = await supabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { status: 'anonymous' }

  const { data: membership } = await supabase
    .from('household_members')
    .select('household_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (membership) {
    return { status: 'ok', householdId: membership.household_id as string }
  }

  // First login: bootstrap household, home and floor in one round trip.
  const { data, error } = await supabase.rpc('bootstrap_household', {
    household_name: user.email ?? 'Home',
  })

  if (error) {
    // Raised by the allowlist gate. Anything else is a real failure.
    if (error.message?.includes('NOT_INVITED')) {
      return { status: 'not_invited', email: user.email ?? null }
    }
    throw error
  }
  return { status: 'ok', householdId: data as string }
}

/** The household id, or null. For callers that do not distinguish the reasons. */
export async function currentHouseholdId(): Promise<string | null> {
  const result = await currentHousehold()
  return result.status === 'ok' ? result.householdId : null
}
