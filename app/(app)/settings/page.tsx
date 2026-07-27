import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentHousehold, supabaseServer } from '@/lib/db/server'
import { isNotionConfigured } from '@/lib/notion/client'

export const metadata = { title: 'Settings' }

/**
 * The settings index. One entry today; it exists so `/settings/sync` has a
 * parent to go back to rather than dead-ending at the app bar.
 */
export default async function SettingsPage() {
  const householdId = await currentHousehold()
  if (!householdId) redirect('/login')

  const supabase = await supabaseServer()
  const [{ count: openConflicts }, { count: queued }] = await Promise.all([
    supabase.from('sync_conflicts').select('id', { count: 'exact', head: true })
      .eq('household_id', householdId).is('resolved_at', null),
    supabase.from('sync_jobs').select('id', { count: 'exact', head: true })
      .eq('household_id', householdId).in('status', ['queued', 'running']),
  ])

  const configured = isNotionConfigured()
  const state: 'ok' | 'pending' | 'error' =
    !configured ? 'pending'
      : (openConflicts ?? 0) > 0 ? 'error'
        : (queued ?? 0) > 0 ? 'pending' : 'ok'

  const summary = !configured
    ? 'Not connected yet'
    : (openConflicts ?? 0) > 0
      ? `${openConflicts} unresolved ${openConflicts === 1 ? 'conflict' : 'conflicts'}`
      : (queued ?? 0) > 0
        ? `${queued} queued`
        : 'Everything in sync'

  return (
    <>
      <div className="mb-3">
        <p className="eyebrow">Settings</p>
        <h1 className="zonename">Settings</h1>
      </div>

      <ul className="list-none p-0">
        <li>
          <Link href="/settings/sync" className="surface block p-4 no-underline" style={{ color: 'var(--ink)' }}>
            <div className="flex items-center justify-between gap-3">
              <span className="zonename">Notion sync</span>
              <span className="mono muted flex items-center gap-1.5 text-[11px]">
                <span className="dot" data-state={state} aria-hidden="true" />
                {summary}
              </span>
            </div>
            <p className="muted mt-1 text-sm">
              Connection status, the sync log, conflicts and a manual reconcile.
            </p>
          </Link>
        </li>
      </ul>
    </>
  )
}
