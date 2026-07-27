'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  connectDatabases,
  createNotionDatabases,
  type ConnectPending,
} from '@/app/actions/notion'

type Props = {
  /** False when NOTION_TOKEN is unset: the form explains rather than pretending. */
  tokenPresent: boolean
  /** Prefill when reconnecting an already configured household. */
  itemsDatabaseId?: string | null
  locationsDatabaseId?: string | null
}

type Mode = 'create' | 'connect'

/**
 * Section 7.3. Two ways in: let the app build both databases under a page you
 * pick, or point it at two you already made.
 *
 * The data source picker only appears when section 7.2's ambiguous case
 * actually happens, so the common path stays two fields and a button.
 */
export function ConnectForm({ tokenPresent, itemsDatabaseId, locationsDatabaseId }: Props) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(itemsDatabaseId ? 'connect' : 'create')
  const [parentPageId, setParentPageId] = useState('')
  const [itemsId, setItemsId] = useState(itemsDatabaseId ?? '')
  const [locationsId, setLocationsId] = useState(locationsDatabaseId ?? '')
  const [pending, setPending] = useState<ConnectPending | null>(null)
  const [picked, setPicked] = useState<{ items?: string; locations?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, start] = useTransition()

  function create(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    start(async () => {
      const res = await createNotionDatabases({ parentPageId })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setNotice('Created Storage items and Storage locations in Notion.')
      router.refresh()
    })
  }

  function connect(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    start(async () => {
      const res = await connectDatabases({
        itemsDatabaseId: itemsId,
        locationsDatabaseId: locationsId,
        itemsDataSourceId: picked.items ?? null,
        locationsDataSourceId: picked.locations ?? null,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      if (res.data.pending) {
        // Section 7.2: more than one data source, so the app refuses to guess.
        setPending(res.data.pending)
        return
      }
      setPending(null)
      setNotice('Connected. The next drain will start mirroring.')
      router.refresh()
    })
  }

  return (
    <section className="surface p-4" aria-labelledby="connect-heading">
      <h2 id="connect-heading" className="zonename">Connect Notion</h2>

      {!tokenPresent && (
        <p className="muted mt-2 text-sm">
          Set <code className="mono">NOTION_TOKEN</code> in the environment and redeploy before
          using either option below.
        </p>
      )}

      <div className="mt-3 flex gap-2" role="tablist" aria-label="Connection method">
        <button
          type="button" role="tab" className="btn" aria-selected={mode === 'create'}
          style={mode === 'create' ? { background: 'var(--accent)', borderColor: 'var(--accent-line)', color: 'var(--on-accent)' } : undefined}
          onClick={() => setMode('create')}
        >
          Create databases
        </button>
        <button
          type="button" role="tab" className="btn" aria-selected={mode === 'connect'}
          style={mode === 'connect' ? { background: 'var(--accent)', borderColor: 'var(--accent-line)', color: 'var(--on-accent)' } : undefined}
          onClick={() => setMode('connect')}
        >
          Connect existing
        </button>
      </div>

      {mode === 'create' ? (
        <form onSubmit={create} className="mt-3 grid gap-2">
          <label htmlFor="parent-page" className="eyebrow">Parent page</label>
          <input
            id="parent-page"
            className="field"
            value={parentPageId}
            onChange={(e) => setParentPageId(e.target.value)}
            placeholder="Paste the Notion page URL"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="muted text-sm">
            The integration must already be invited to this page, or Notion will refuse.
            Both databases are created inside it.
          </p>
          <button className="btn primary justify-self-start" type="submit" disabled={busy || !tokenPresent || !parentPageId.trim()}>
            {busy ? 'Creating…' : 'Create databases in Notion'}
          </button>
        </form>
      ) : (
        <form onSubmit={connect} className="mt-3 grid gap-2">
          <label htmlFor="items-db" className="eyebrow">Storage items database</label>
          <input
            id="items-db" className="field" value={itemsId} spellCheck={false} autoComplete="off"
            onChange={(e) => { setItemsId(e.target.value); setPicked((p) => ({ ...p, items: undefined })) }}
            placeholder="Paste the database URL"
          />

          <label htmlFor="locations-db" className="eyebrow mt-2">Storage locations database</label>
          <input
            id="locations-db" className="field" value={locationsId} spellCheck={false} autoComplete="off"
            onChange={(e) => { setLocationsId(e.target.value); setPicked((p) => ({ ...p, locations: undefined })) }}
            placeholder="Paste the database URL"
          />

          {pending && (
            <fieldset className="surface mt-2 p-3">
              <legend className="eyebrow px-1">Pick a data source for {pending.label}</legend>
              <p className="muted text-sm">
                That database holds more than one data source, so the app will not guess which
                one to sync.
              </p>
              <div className="mt-2 grid gap-1">
                {pending.choices.map((choice) => {
                  const key = pending.field === 'itemsDataSourceId' ? 'items' : 'locations'
                  return (
                    <label key={choice.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={pending.field}
                        value={choice.id}
                        checked={picked[key] === choice.id}
                        onChange={() => setPicked((p) => ({ ...p, [key]: choice.id }))}
                      />
                      <span>{choice.name || 'Untitled'}</span>
                      <span className="mono muted text-[11px]">{choice.id}</span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )}

          <button
            className="btn primary mt-2 justify-self-start"
            type="submit"
            disabled={busy || !tokenPresent || !itemsId.trim() || !locationsId.trim()}
          >
            {busy ? 'Connecting…' : pending ? 'Use this data source' : 'Connect'}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--err)' }}>{error}</p>
      )}
      {notice && (
        <p role="status" className="muted mt-3 text-sm">{notice}</p>
      )}
    </section>
  )
}
