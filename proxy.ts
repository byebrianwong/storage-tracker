import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/**
 * Next 16 renamed the middleware convention to proxy.
 *
 * Refreshes the Supabase session cookie on every request and gates the app
 * routes behind auth. The sync endpoints authenticate with CRON_SECRET instead,
 * and the Notion webhook authenticates with an HMAC, so both are excluded.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    },
  )

  const { data: { user } } = await supabase.auth.getUser()
  const { pathname } = request.nextUrl

  /*
    Routes that must work without a session:
      /demo           the public demo, sample data only, no database
      /request-access where a not-invited user lands, and the demo's CTA
      /login, /auth   the magic link flow itself
  */
  const isPublic = pathname.startsWith('/demo') || pathname.startsWith('/request-access')
  const isAuthRoute = isPublic || pathname.startsWith('/login') || pathname.startsWith('/auth')
  if (!user && !isAuthRoute) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }
  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/plan'
    url.searchParams.delete('next')
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the API routes that carry their own
     * authentication: /api/notion/webhook verifies an HMAC, /api/sync/* checks
     * CRON_SECRET. Running them through the session check would break both.
     */
    '/((?!_next/static|_next/image|favicon.ico|api/notion|api/sync|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
