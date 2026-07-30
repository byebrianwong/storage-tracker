import Link from 'next/link'
import { currentHousehold } from '@/lib/db/server'
import { redirect } from 'next/navigation'
import { RequestForm } from './RequestForm'

/**
 * Where a signed-in-but-not-invited user lands, and where the demo's call to
 * action points. Reachable without a session on purpose.
 */
export default async function RequestAccessPage() {
  const household = await currentHousehold()
  // Already in? Nothing to ask for.
  if (household.status === 'ok') redirect('/plan')

  const email = household.status === 'not_invited' ? household.email : null

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md items-center px-4 py-10">
      <div className="w-full">
        <div className="surface p-6">
          <p className="eyebrow mb-1">Where is it</p>
          <h1 className="zonename mb-3">
            {email ? 'You are signed in, but not on the list yet' : 'Request access'}
          </h1>

          <p className="muted mb-5 text-sm leading-relaxed">
            {email
              ? <>This is a small personal app and accounts are invite only for now.
                  Leave a note and Brian will see it.</>
              : <>This is a small personal app, invite only for now. If you would like
                  an account, leave your email and Brian will see it.</>}
          </p>

          <RequestForm defaultEmail={email} />
        </div>

        <p className="muted mt-4 text-center text-sm">
          Want to look around first? <Link href="/demo">Try the demo</Link> — no account needed.
        </p>
      </div>
    </main>
  )
}
