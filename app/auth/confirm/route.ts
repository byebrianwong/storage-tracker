import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { supabaseServer, currentHousehold } from '@/lib/db/server'

/**
 * Magic link landing. Verifies the OTP, then makes sure the user has a
 * household before letting them into the app, so first login lands on a
 * working plan view rather than an empty one.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next') ?? '/plan'

  if (!token_hash || !type) {
    return NextResponse.redirect(`${origin}/login?error=missing_token`)
  }

  const supabase = await supabaseServer()
  const { error } = await supabase.auth.verifyOtp({ type, token_hash })
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`)
  }

  await currentHousehold()

  // Only ever redirect to a path on this origin, never to a caller supplied URL.
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/plan'
  return NextResponse.redirect(`${origin}${safeNext}`)
}
