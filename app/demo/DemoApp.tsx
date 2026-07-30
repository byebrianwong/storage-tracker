'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { PlanCanvas } from '@/components/plan/PlanCanvas'
import { ElevationCanvas } from '@/components/elevation/ElevationCanvas'
import { SKINS, type SkinId } from '@/lib/theme/tags'
import {
  DEMO_ZONES, DEMO_ITEMS, DEMO_PLAN_ZONES, DEMO_INDEX, DEMO_TOTAL_ITEMS,
  DEMO_PLAN_URL, DEMO_PLAN_SIZE, type DemoItem,
} from '@/lib/demo/sample'

/**
 * The whole app, running on fixed sample data with no database and no account.
 *
 * Deliberately the real PlanCanvas and ElevationCanvas rather than screenshots,
 * so what a visitor pokes at is genuinely the app. Edits live in React state and
 * disappear on reload, which the banner says plainly.
 */
export function DemoApp() {
  const [skin, setSkin] = useState<SkinId>('a')
  const [zoneId, setZoneId] = useState<string | null>(null)
  const [containerId, setContainerId] = useState<string | null>(null)
  const [items, setItems] = useState<Record<string, DemoItem[]>>(DEMO_ITEMS)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')

  const zone = DEMO_ZONES.find((z) => z.id === zoneId) ?? null

  const hits = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return null
    return DEMO_INDEX.filter(
      (row) => row.item.name.toLowerCase().includes(term) ||
        row.tag.toLowerCase().includes(term) ||
        row.zoneName.toLowerCase().includes(term) ||
        row.containerLabel.toLowerCase().includes(term),
    ).slice(0, 8)
  }, [query])

  const highlighted = useMemo(() => {
    if (!hits) return undefined
    return new Set(hits.flatMap((h) => [h.zoneId, h.containerId]))
  }, [hits])

  // Counts must reflect demo edits, so recompute rather than use the static ones.
  const planZones = useMemo(() => DEMO_PLAN_ZONES.map((z) => {
    const source = DEMO_ZONES.find((d) => d.id === z.id)
    const count = source
      ? source.shelves.reduce((n, s) =>
        n + s.containers.reduce((m, c) => m + (items[c.id]?.length ?? 0), 0), 0)
      : z.itemCount
    return { ...z, itemCount: count }
  }), [items])

  const zoneWithCounts = useMemo(() => zone && ({
    ...zone,
    shelves: zone.shelves.map((s) => ({
      ...s,
      containers: s.containers.map((c) => ({ ...c, item_count: items[c.id]?.length ?? 0 })),
    })),
  }), [zone, items])

  const selected = zone?.shelves
    .flatMap((s) => s.containers.map((c) => ({ container: c, shelfName: s.name })))
    .find((e) => e.container.id === containerId) ?? null

  const total = Object.values(items).reduce((n, list) => n + list.length, 0)

  function openHit(h: (typeof DEMO_INDEX)[number]) {
    setZoneId(h.zoneId)
    setContainerId(h.containerId)
    setQuery('')
  }

  return (
    <div data-skin={skin} style={{ background: 'var(--paper)', color: 'var(--ink)', minHeight: '100dvh' }}>
      <div
        className="flex flex-wrap items-center gap-3 px-4 py-3"
        style={{ background: 'var(--bar-bg)', borderBottom: 'var(--rule)' }}
      >
        <span className="brand shrink-0">Where is it</span>
        <span className="mono muted text-[11px]">Demo · nothing is saved</span>
        <Link href="/request-access" className="btn ml-auto shrink-0" style={{ minHeight: 36, fontSize: 12 }}>
          Request access
        </Link>
      </div>

      <main className="mx-auto w-full max-w-6xl px-4 py-4">
        <div className="relative mb-4">
          <label htmlFor="demo-search" className="sr-only">Find an item</label>
          <input
            id="demo-search"
            className="field"
            style={{ fontSize: 13, padding: '8px 12px' }}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find an item, try “sleeping bag” or “camping”"
          />
          {hits && (
            <div
              className="surface absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-72 overflow-auto"
              style={{ boxShadow: 'var(--shadow)' }}
              role="listbox"
            >
              {hits.length === 0 && (
                <p className="muted p-3 text-sm">No match. Try a category like camping or docs.</p>
              )}
              {hits.map((h) => (
                <button
                  key={h.item.id}
                  role="option"
                  aria-selected={false}
                  className="rule block w-full border-0 p-2.5 text-left text-sm last:border-b-0"
                  onClick={() => openHit(h)}
                >
                  {h.item.name}
                  <span className="mono muted mt-0.5 block text-[11px]">
                    {h.zoneName} / {h.shelfName} / {h.containerLabel}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <section className="min-w-0">
            <p className="eyebrow mb-1">Floor plan</p>
            <p className="muted mb-2 text-sm">
              {zone ? 'Tap another area to switch.' : 'Tap a storage area to see it straight on.'}
            </p>
            <PlanCanvas
              planUrl={DEMO_PLAN_URL}
              planWidth={DEMO_PLAN_SIZE.width}
              planHeight={DEMO_PLAN_SIZE.height}
              zones={planZones}
              selectedZoneId={zoneId}
              highlightedIds={highlighted}
              onSelect={(id) => { setZoneId(id); setContainerId(null) }}
            />
            <p className="mono muted mt-2 text-[10px]">
              {planZones.length} storage areas, {total} items
              {total !== DEMO_TOTAL_ITEMS && ' (edited)'}
            </p>
          </section>

          <section className="min-w-0">
            {zoneWithCounts ? (
              <>
                <p className="eyebrow mb-1">{zoneWithCounts.room_label} / straight on view</p>
                <h2 className="zonename mb-2">{zoneWithCounts.name}</h2>
                <ElevationCanvas
                  zone={zoneWithCounts}
                  selectedContainerId={containerId}
                  highlightedIds={highlighted}
                  onSelect={setContainerId}
                />

                {selected && (
                  <aside className="surface mt-3 p-4">
                    <h3 className="zonename">{selected.container.label}</h3>
                    <p className="mono muted mt-0.5 text-xs">
                      {zoneWithCounts.name} / {selected.shelfName}
                    </p>

                    <ul className="mt-3 list-none p-0">
                      {(items[selected.container.id] ?? []).map((item) => (
                        <li key={item.id} className="rule flex items-center justify-between gap-3 py-2 last:border-b-0">
                          <span className="text-sm">{item.name}</span>
                          <button
                            className="muted text-xs underline underline-offset-2"
                            onClick={() => setItems((prev) => ({
                              ...prev,
                              [selected.container.id]: (prev[selected.container.id] ?? [])
                                .filter((i) => i.id !== item.id),
                            }))}
                            aria-label={`Remove ${item.name}`}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                      {(items[selected.container.id] ?? []).length === 0 && (
                        <li className="muted py-2 text-sm">
                          Nothing logged here yet. Add the first item.
                        </li>
                      )}
                    </ul>

                    <form
                      className="mt-3 flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        const name = draft.trim()
                        if (!name) return
                        setItems((prev) => ({
                          ...prev,
                          [selected.container.id]: [
                            ...(prev[selected.container.id] ?? []),
                            { id: `new-${Math.random().toString(36).slice(2)}`, name, quantity: 1 },
                          ],
                        }))
                        setDraft('')
                      }}
                    >
                      <input
                        className="field"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Add an item"
                        aria-label="Add an item"
                      />
                      <button className="btn primary shrink-0" type="submit" disabled={!draft.trim()}>
                        Add
                      </button>
                    </form>
                    <p className="muted mt-2 text-xs">
                      Try it — this is the real thing, it just forgets on reload.
                    </p>
                  </aside>
                )}
              </>
            ) : (
              <div className="surface flex h-full min-h-48 flex-col items-center justify-center p-8 text-center">
                <p className="muted text-sm">
                  Pick a storage area on the plan and it appears here, drawn from the data.
                </p>
              </div>
            )}
          </section>
        </div>

        <div className="mt-8" style={{ borderTop: 'var(--rule)', paddingTop: 16 }}>
          <p className="eyebrow mb-2">Same data, three looks</p>
          <div className="flex flex-wrap items-center gap-2">
            {SKINS.map((s) => (
              <button
                key={s.id}
                className="btn"
                style={{
                  minHeight: 34, padding: '4px 10px', fontSize: 12,
                  ...(s.id === skin
                    ? { background: 'var(--accent)', borderColor: 'var(--accent-line)', color: 'var(--on-accent)' }
                    : {}),
                }}
                aria-pressed={s.id === skin}
                onClick={() => setSkin(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
          <p className="muted mt-2 max-w-2xl text-sm">{SKINS.find((s) => s.id === skin)?.blurb}</p>
        </div>

        <div className="surface mt-6 p-5 text-center">
          <p className="mb-3 text-sm leading-relaxed">
            This is a personal project, invite only for now.
            If you would find it useful, say so and I will know there is interest.
          </p>
          <Link href="/request-access" className="btn primary">Request access</Link>
        </div>
      </main>
    </div>
  )
}
