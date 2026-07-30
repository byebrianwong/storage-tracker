import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentHouseholdId, supabaseServer } from '@/lib/db/server'
import { NOTION_VERSION } from '@/lib/notion/client'
import {
  notionUrl,
  verifyConnection,
  type ConnectionReport,
  type DatabaseReport,
} from '@/lib/notion/setup'
import { ConnectForm } from './ConnectForm'
import { ConflictCard, type ConflictView } from './ConflictCard'
import { ReconcileButton } from './ReconcileButton'

export const metadata = { title: 'Notion sync' }
// Reads cookies and live queue state; never cache it.
export const dynamic = 'force-dynamic'

/** Section 7.8. Everything a human needs to answer "is the sync healthy". */

const EVENT_LIMIT = 50

type Row = Record<string, unknown>

export default async function SyncSettingsPage() {
  const householdId = await currentHouseholdId()
  if (!householdId) redirect('/login')

  const supabase = await supabaseServer()

  // Connection state only. The webhook HMAC key lives in `notion_secrets`,
  // which has RLS on and no policy, so this page could not read it anyway.
  const { data: config } = await supabase
    .from('notion_config')
    .select('items_database_id, items_data_source_id, locations_database_id, locations_data_source_id, parent_page_id, notion_version, connected_at')
    .eq('household_id', householdId)
    .maybeSingle()

  const [
    { data: jobs },
    { data: runs },
    { data: lastDrain },
    { data: lastReconcile },
    { count: queueDepth },
    { count: failedJobs },
    { data: conflictRows },
  ] = await Promise.all([
    supabase.from('sync_jobs')
      .select('id, direction, entity_type, op, status, attempts, last_error, created_at')
      .eq('household_id', householdId)
      .order('created_at', { ascending: false })
      .limit(EVENT_LIMIT),
    supabase.from('sync_runs')
      .select('id, kind, started_at, finished_at, ok, stats')
      .eq('household_id', householdId)
      .order('started_at', { ascending: false })
      .limit(EVENT_LIMIT),
    supabase.from('sync_runs')
      .select('finished_at, stats')
      .eq('household_id', householdId).eq('kind', 'drain').eq('ok', true)
      .order('started_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('sync_runs')
      .select('kind, finished_at, stats')
      .eq('household_id', householdId).like('kind', 'reconcile%').eq('ok', true)
      .order('started_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('sync_jobs').select('id', { count: 'exact', head: true })
      .eq('household_id', householdId).in('status', ['queued', 'running']),
    supabase.from('sync_jobs').select('id', { count: 'exact', head: true })
      .eq('household_id', householdId).eq('status', 'failed'),
    supabase.from('sync_conflicts')
      .select('id, item_id, app_value, notion_value, created_at, items(name)')
      .eq('household_id', householdId)
      .is('resolved_at', null)
      .order('created_at', { ascending: false })
      .limit(EVENT_LIMIT),
  ])

  const report = await verifyConnection({
    itemsDatabaseId: (config?.items_database_id as string | null) ?? null,
    itemsDataSourceId: (config?.items_data_source_id as string | null) ?? null,
    locationsDatabaseId: (config?.locations_database_id as string | null) ?? null,
    locationsDataSourceId: (config?.locations_data_source_id as string | null) ?? null,
  })

  const events = buildEvents((jobs ?? []) as Row[], (runs ?? []) as Row[])
  const conflicts = buildConflicts((conflictRows ?? []) as Row[])
  const connected = Boolean(config?.items_data_source_id)

  return (
    <>
      <nav className="mono muted mb-3 text-[11px]" aria-label="Breadcrumb">
        <Link href="/settings" className="no-underline" style={{ color: 'var(--muted)' }}>Settings</Link>
        <span aria-hidden="true"> / </span>
        <span style={{ color: 'var(--ink)' }}>Notion sync</span>
      </nav>

      <div className="mb-4">
        <p className="eyebrow">Notion</p>
        <h1 className="zonename">Sync</h1>
      </div>

      <div className="grid gap-4">
        <ConnectionStatus report={report} connected={connected} />

        {!report.tokenPresent && <SetupInstructions />}

        {report.tokenPresent && !connected && (
          <ConnectForm tokenPresent={report.tokenPresent} />
        )}

        {connected && (
          <>
            <DatabaseCard report={report.locations} />
            <DatabaseCard report={report.items} />
          </>
        )}

        <section className="surface p-4" aria-labelledby="health-heading">
          <h2 id="health-heading" className="zonename">Queue</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat
              label="Queue depth"
              value={`${queueDepth ?? 0}`}
              detail={(failedJobs ?? 0) > 0 ? `${failedJobs} failed` : 'nothing stuck'}
            />
            <Stat
              label="Last successful drain"
              value={relativeTime((lastDrain?.finished_at as string | null) ?? null)}
              detail={absolute((lastDrain?.finished_at as string | null) ?? null)}
            />
            <Stat
              label="Last successful reconcile"
              value={relativeTime((lastReconcile?.finished_at as string | null) ?? null)}
              detail={lastReconcile
                ? `${String(lastReconcile.kind ?? 'reconcile')}, ${absolute((lastReconcile.finished_at as string | null) ?? null)}`
                : 'never'}
            />
          </dl>
          <div className="mt-4">
            <ReconcileButton disabled={!connected} />
            {!connected && (
              <p className="muted mt-2 text-sm">Connect the databases first.</p>
            )}
          </div>
        </section>

        <section className="surface p-4" aria-labelledby="conflicts-heading">
          <h2 id="conflicts-heading" className="zonename">
            Conflicts{conflicts.length > 0 ? ` (${conflicts.length})` : ''}
          </h2>
          <p className="muted mt-1 text-sm">
            Both sides changed the same item since the last sync. Pick the value to keep; the
            other side is overwritten on the next drain.
          </p>
          {conflicts.length === 0 ? (
            <p className="muted mt-3 text-sm">Nothing to resolve.</p>
          ) : (
            <ul className="mt-3 grid list-none gap-3 p-0">
              {conflicts.map((c) => <ConflictCard key={c.id} conflict={c} />)}
            </ul>
          )}
        </section>

        <section className="surface p-4" aria-labelledby="log-heading">
          <h2 id="log-heading" className="zonename">Sync log</h2>
          <p className="muted mt-1 text-sm">The last {EVENT_LIMIT} events, newest first.</p>
          {events.length === 0 ? (
            <p className="muted mt-3 text-sm">
              Nothing has synced yet. Events appear here as soon as the first drain runs.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="eyebrow rule py-1 pr-3 text-left">When</th>
                    <th scope="col" className="eyebrow rule py-1 pr-3 text-left">Entity</th>
                    <th scope="col" className="eyebrow rule py-1 pr-3 text-left">Direction</th>
                    <th scope="col" className="eyebrow rule py-1 text-left">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.key}>
                      <td className="rule py-1 pr-3 align-top whitespace-nowrap">
                        <time className="mono muted text-[11px]" dateTime={e.at} title={absolute(e.at) ?? undefined}>
                          {relativeTime(e.at)}
                        </time>
                      </td>
                      <td className="rule py-1 pr-3 align-top">{e.entity}</td>
                      <td className="mono rule py-1 pr-3 align-top text-[11px]">{e.direction}</td>
                      <td className="rule py-1 align-top">
                        <span className="flex items-start gap-1.5">
                          <span className="dot mt-1.5 shrink-0" data-state={e.state} aria-hidden="true" />
                          <span>
                            {e.result}
                            {e.detail && (
                              <span className="muted block text-[11px]">{e.detail}</span>
                            )}
                          </span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {report.tokenPresent && connected && (
          <ConnectForm
            tokenPresent={report.tokenPresent}
            itemsDatabaseId={(config?.items_database_id as string | null) ?? null}
            locationsDatabaseId={(config?.locations_database_id as string | null) ?? null}
          />
        )}
      </div>
    </>
  )
}

// --------------------------------------------------------------------------
// Presentation
// --------------------------------------------------------------------------

function Stat({ label, value, detail }: { label: string; value: string; detail: string | null }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="zonename m-0 mt-0.5">{value}</dd>
      {detail && <p className="mono muted mt-0.5 text-[11px]">{detail}</p>}
    </div>
  )
}

function ConnectionStatus({ report, connected }: { report: ConnectionReport; connected: boolean }) {
  const state: 'ok' | 'pending' | 'error' =
    !report.tokenPresent ? 'pending'
      : !report.tokenValid ? 'error'
        : !connected ? 'pending'
          : report.ok ? 'ok' : 'error'

  const headline =
    !report.tokenPresent ? 'Not configured'
      : !report.tokenValid ? 'Token rejected'
        : !connected ? 'Token works, no databases connected'
          : report.ok ? 'Connected' : 'Connected, schema needs attention'

  return (
    <section className="surface p-4" aria-labelledby="status-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="status-heading" className="zonename flex items-center gap-2">
          <span className="dot" data-state={state} aria-hidden="true" />
          {headline}
        </h2>
        <span className="mono muted text-[11px]">Notion-Version {NOTION_VERSION}</span>
      </div>

      {report.workspace && (
        <p className="muted mt-1 text-sm">
          Workspace {report.workspace}
          {report.botName ? `, integration ${report.botName}` : ''}
        </p>
      )}
      {report.error && (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--err)' }}>{report.error}</p>
      )}
    </section>
  )
}

/** Section 11 case 10: the schema report, so drift is visible before it breaks a sync. */
function DatabaseCard({ report }: { report: DatabaseReport }) {
  const state: 'ok' | 'pending' | 'error' =
    !report.configured ? 'pending' : report.ok ? 'ok' : 'error'
  const href = report.url ?? notionUrl(report.databaseId)

  return (
    <section className="surface p-4" aria-labelledby={`db-${report.label.replace(/\s+/g, '-')}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`db-${report.label.replace(/\s+/g, '-')}`} className="zonename flex items-center gap-2">
          <span className="dot" data-state={state} aria-hidden="true" />
          {report.label}
        </h2>
        {href && (
          <a className="mono text-[11px]" href={href} target="_blank" rel="noreferrer noopener">
            Open in Notion
          </a>
        )}
      </div>

      <p className="mono muted mt-1 text-[11px]">
        data source {report.dataSourceId ?? 'not set'}
      </p>

      {report.error && (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--err)' }}>{report.error}</p>
      )}

      {report.properties.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{report.label} property check</caption>
            <thead>
              <tr>
                <th scope="col" className="eyebrow rule py-1 pr-3 text-left">Property</th>
                <th scope="col" className="eyebrow rule py-1 pr-3 text-left">Expected</th>
                <th scope="col" className="eyebrow rule py-1 pr-3 text-left">In Notion</th>
                <th scope="col" className="eyebrow rule py-1 text-left">Direction</th>
              </tr>
            </thead>
            <tbody>
              {report.properties.map((p) => (
                <tr key={p.name}>
                  <th scope="row" className="rule py-1 pr-3 text-left align-top font-normal">
                    {p.name}
                    {p.detail && (
                      <span
                        className="block text-[11px]"
                        style={{ color: p.ok ? 'var(--muted)' : 'var(--err)' }}
                      >
                        {p.detail}
                      </span>
                    )}
                  </th>
                  <td className="mono rule py-1 pr-3 align-top text-[11px]">{p.expectedType}</td>
                  <td
                    className="mono rule py-1 pr-3 align-top text-[11px]"
                    style={p.ok ? undefined : { color: 'var(--err)' }}
                  >
                    {p.actualType ?? 'missing'}
                  </td>
                  <td className="mono muted rule py-1 align-top text-[11px]">{p.direction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.extraProperties.length > 0 && (
        <p className="muted mt-2 text-[11px]">
          Also present, ignored by the sync: {report.extraProperties.join(', ')}
        </p>
      )}
    </section>
  )
}

/** Section 12. The default state of this app is "no token", so say what to do. */
function SetupInstructions() {
  return (
    <section className="surface p-4" aria-labelledby="setup-heading">
      <h2 id="setup-heading" className="zonename">Set Notion up</h2>
      <p className="muted mt-1 text-sm">
        Nothing here is broken. Notion sync is off because the server has no token, and the
        rest of the app works without it.
      </p>

      <ol className="mt-3 grid list-decimal gap-2 pl-5 text-sm">
        <li>
          Create an internal integration at{' '}
          <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noreferrer noopener">
            notion.so/profile/integrations
          </a>{' '}
          and copy its token.
        </li>
        <li>
          Set <code className="mono">NOTION_TOKEN</code> in the environment, alongside{' '}
          <code className="mono">CRON_SECRET</code> and <code className="mono">APP_URL</code>,
          then redeploy.
        </li>
        <li>In Notion, invite the integration to the page the databases should live under.</li>
        <li>Come back here and run <strong>Create databases in Notion</strong>.</li>
        <li>
          In the integration&rsquo;s connection settings, add a webhook subscription pointing at{' '}
          <code className="mono">{'{APP_URL}'}/api/notion/webhook</code>.
        </li>
        <li>
          Notion posts a one time <code className="mono">verification_token</code>. It is logged
          at warn level and stored; paste it back into Notion and confirm the subscription reads
          active.
        </li>
      </ol>

      <p className="muted mt-3 text-sm">
        Notion cannot reach localhost. For local testing use a tunnel, and expect to recreate the
        subscription if the tunnel URL changes, because the URL is locked once verified.
      </p>
    </section>
  )
}

// --------------------------------------------------------------------------
// Data shaping
// --------------------------------------------------------------------------

type SyncEvent = {
  key: string
  at: string
  entity: string
  direction: string
  result: string
  state: 'ok' | 'pending' | 'error'
  detail: string | null
}

/**
 * Section 7.8 asks for entity, direction and result. Two tables hold that:
 * `sync_jobs` is one row per entity, `sync_runs` is one row per drain or
 * reconcile pass. Merged and sorted, they read as one timeline.
 */
function buildEvents(jobs: Row[], runs: Row[]): SyncEvent[] {
  const fromJobs = jobs.map((j): SyncEvent => {
    const status = String(j.status ?? 'queued')
    const attempts = Number(j.attempts ?? 0)
    return {
      key: `job-${String(j.id)}`,
      at: String(j.created_at ?? ''),
      entity: String(j.entity_type ?? 'item'),
      direction: String(j.direction ?? 'push'),
      result: `${status}${j.op ? ` (${String(j.op)})` : ''}`,
      state: status === 'failed' ? 'error' : status === 'done' ? 'ok' : 'pending',
      detail: (j.last_error as string | null)
        ?? (attempts > 0 ? `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}` : null),
    }
  })

  const fromRuns = runs.map((r): SyncEvent => {
    const ok = r.ok as boolean | null
    return {
      key: `run-${String(r.id)}`,
      at: String(r.started_at ?? ''),
      entity: String(r.kind ?? 'run'),
      direction: 'run',
      result: ok === true ? 'ok' : ok === false ? 'failed' : 'running',
      state: ok === true ? 'ok' : ok === false ? 'error' : 'pending',
      detail: summarizeStats(r.stats),
    }
  })

  return [...fromJobs, ...fromRuns]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, EVENT_LIMIT)
}

/** Both drain and reconcile write a stats blob; neither shape is worth a schema. */
function summarizeStats(stats: unknown): string | null {
  if (typeof stats !== 'object' || stats === null || Array.isArray(stats)) return null
  const s = stats as Record<string, unknown>

  if (typeof s.error === 'string') return s.error

  const parts: string[] = []

  if (typeof s.scanned === 'number') parts.push(`${s.scanned} scanned`)
  if (s.outcomes && typeof s.outcomes === 'object') {
    for (const [k, v] of Object.entries(s.outcomes as Record<string, unknown>)) {
      if (typeof v === 'number' && v > 0) parts.push(`${k.replace(/_/g, ' ')} ${v}`)
    }
  }
  if (typeof s.unlinkedItems === 'number' && s.unlinkedItems > 0) {
    parts.push(`${s.unlinkedItems} unlinked`)
  }
  if (Array.isArray(s.orphanPages) && s.orphanPages.length > 0) {
    parts.push(`${s.orphanPages.length} orphan pages`)
  }

  const push = s.push as Record<string, unknown> | undefined | null
  if (push && typeof push === 'object') {
    for (const key of ['pushed', 'skippedByHash', 'archived', 'failed', 'retried'] as const) {
      const v = push[key]
      if (typeof v === 'number' && v > 0) parts.push(`${key.replace(/([A-Z])/g, ' $1').toLowerCase()} ${v}`)
    }
  }

  const pull = s.pull as Record<string, unknown> | undefined | null
  if (pull && typeof pull === 'object') {
    for (const [k, v] of Object.entries(pull)) {
      if (typeof v === 'number' && v > 0) parts.push(`${k.replace(/_/g, ' ')} ${v}`)
    }
  }

  if (Array.isArray(s.errors) && s.errors.length > 0) {
    parts.push(`${s.errors.length} ${s.errors.length === 1 ? 'error' : 'errors'}`)
  }

  return parts.length > 0 ? parts.join(', ') : null
}

function buildConflicts(rows: Row[]): ConflictView[] {
  return rows.map((r): ConflictView => {
    const joined = r.items as { name?: unknown } | { name?: unknown }[] | null | undefined
    const item = Array.isArray(joined) ? joined[0] : joined
    const createdAt = String(r.created_at ?? '')
    return {
      id: String(r.id),
      itemName: typeof item?.name === 'string' && item.name !== ''
        ? item.name
        : 'Deleted item',
      createdAt,
      createdLabel: relativeTime(createdAt),
      appValue: asRecord(r.app_value),
      notionValue: asRecord(r.notion_value),
    }
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// --------------------------------------------------------------------------
// Time
// --------------------------------------------------------------------------

/** Rendered on the server, so it is plain text with no hydration to mismatch. */
function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'unknown'

  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** UTC, so the string does not depend on which region rendered it. */
function absolute(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
