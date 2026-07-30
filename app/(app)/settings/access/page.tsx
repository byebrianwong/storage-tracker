import Link from 'next/link'
import { supabaseServer } from '@/lib/db/server'
import { RequestRow } from './RequestRow'

type Row = {
  id: string
  email: string
  note: string | null
  status: string
  created_at: string
  resolved_at: string | null
}

export default async function AccessSettingsPage() {
  const supabase = await supabaseServer()
  const { data, error } = await supabase
    .from('access_requests')
    .select('id, email, note, status, created_at, resolved_at')
    .order('created_at', { ascending: false })
    .limit(100)

  const rows = (data ?? []) as Row[]
  const pending = rows.filter((r) => r.status === 'pending')
  const resolved = rows.filter((r) => r.status !== 'pending')

  return (
    <>
      <nav className="mono muted mb-3 text-[11px]" aria-label="Breadcrumb">
        <Link href="/settings" className="no-underline" style={{ color: 'var(--muted)' }}>Settings</Link>
        <span aria-hidden="true"> / </span>
        <span style={{ color: 'var(--ink)' }}>Access</span>
      </nav>

      <div className="mb-4">
        <p className="eyebrow">Access</p>
        <h1 className="zonename">Who can sign in</h1>
      </div>

      <p className="muted mb-5 max-w-2xl text-sm leading-relaxed">
        Accounts are invite only. Anyone can try <Link href="/demo">the demo</Link> and ask
        for access here. Approving adds their address to the allowlist; they still
        have to sign in with a magic link themselves.
      </p>

      {error && (
        <p role="alert" className="surface p-3 text-sm" style={{ color: 'var(--err)' }}>
          {error.message}
        </p>
      )}

      <section className="mb-6">
        <h2 className="eyebrow mb-2">Pending{pending.length > 0 && ` (${pending.length})`}</h2>
        {pending.length === 0 && (
          <p className="muted text-sm">Nobody is waiting.</p>
        )}
        <ul className="list-none p-0">
          {pending.map((r) => (
            <li key={r.id}><RequestRow request={r} /></li>
          ))}
        </ul>
      </section>

      {resolved.length > 0 && (
        <section>
          <h2 className="eyebrow mb-2">Handled</h2>
          <ul className="list-none p-0">
            {resolved.map((r) => (
              <li key={r.id} className="rule flex items-center justify-between gap-3 py-2 last:border-b-0">
                <span className="min-w-0 truncate text-sm">{r.email}</span>
                <span className="mono muted shrink-0 text-[11px]">{r.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
