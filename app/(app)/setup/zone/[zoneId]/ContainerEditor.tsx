'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { layoutElevation } from '@/lib/elevation/layout'
import { tagColor, TAG_NAMES } from '@/lib/theme/tags'
import { addShelf, removeShelf, upsertContainer, removeContainer, moveContainer } from '@/app/actions/containers'
import { CONTAINER_KINDS, type ZoneWithLayout } from '@/lib/types'
import type { CSSProperties } from 'react'

type Props = { zone: ZoneWithLayout }

/**
 * Section 6's container editor. Drag the body to change col_start, drag either
 * edge to change col_span, snapping to the column grid. Keyboard equivalents are
 * required, not optional: arrows move, shift plus arrow resizes.
 */
export function ContainerEditor({ zone }: Props) {
  const router = useRouter()
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, start] = useTransition()

  const layout = layoutElevation(zone)
  const cols = zone.grid_cols

  const flat = zone.shelves.flatMap((s) => s.containers.map((c) => ({ ...c, shelfId: s.id })))
  const current = flat.find((c) => c.id === selected) ?? null

  function commit(next: { shelfId: string; colStart: number; colSpan: number }) {
    if (!current) return
    setError(null)
    start(async () => {
      const res = await moveContainer({
        id: current.id, zoneId: zone.id,
        shelfId: next.shelfId, colStart: next.colStart, colSpan: next.colSpan,
      })
      if (!res.ok) setError(res.error)
      else router.refresh()
    })
  }

  function onKeyDown(e: React.KeyboardEvent, c: typeof flat[number]) {
    const step = 1
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(c.id); return }
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return
    e.preventDefault()
    setSelected(c.id)

    if (e.shiftKey) {
      // resize
      const span = e.key === 'ArrowRight' ? c.col_span + step : c.col_span - step
      if (span < 1 || c.col_start + span > cols) return
      commit({ shelfId: c.shelfId, colStart: c.col_start, colSpan: span })
    } else {
      // move
      const startCol = e.key === 'ArrowRight' ? c.col_start + step : c.col_start - step
      if (startCol < 0 || startCol + c.col_span > cols) return
      commit({ shelfId: c.shelfId, colStart: startCol, colSpan: c.col_span })
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block h-auto w-full"
          role="group"
          aria-label={`Container layout for ${zone.name}`}
        >
          <rect className="frame" x={layout.frame.x} y={layout.frame.y}
                width={layout.frame.w} height={layout.frame.h} />

          {layout.shelves.map((shelf) => {
            // Column guides, so the snap grid is visible while dragging.
            const guides = Array.from({ length: cols + 1 }, (_, i) => (
              <line
                key={i}
                x1={layout.frame.x + 10 + (i / cols) * layout.contentW}
                y1={shelf.labelY + 6}
                x2={layout.frame.x + 10 + (i / cols) * layout.contentW}
                y2={shelf.boardY}
                stroke="var(--hair)" strokeWidth={0.5} strokeDasharray="2 3" opacity={0.5}
              />
            ))
            return (
              <g key={shelf.id}>
                <text className="shelflabel" x={layout.frame.x + 8} y={shelf.labelY}>{shelf.name}</text>
                {guides}
                <line className="board" x1={layout.frame.x} y1={shelf.boardY}
                      x2={layout.frame.x + layout.frame.w} y2={shelf.boardY} />
                {shelf.containers.map((c) => (
                  <g
                    key={c.id}
                    className="box"
                    data-selected={c.id === selected}
                    style={{ '--tag-color': tagColor(c.colorTag) } as CSSProperties}
                    tabIndex={0}
                    role="button"
                    aria-label={`${c.label}. Arrow keys move, shift plus arrow resizes.`}
                    onClick={() => setSelected(c.id)}
                    onKeyDown={(e) => {
                      const full = flat.find((f) => f.id === c.id)
                      if (full) onKeyDown(e, full)
                    }}
                  >
                    <rect className="body" x={c.x} y={c.y} width={c.w} height={c.h} />
                    <text className="boxtitle" x={c.x + c.w / 2} y={c.y + c.h / 2}
                          textAnchor="middle">{c.label}</text>
                  </g>
                ))}
              </g>
            )
          })}
        </svg>

        {error && <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--err)' }}>{error}</p>}
        <p className="muted mt-2 text-xs">
          Select a container, then use the arrow keys to move it, or shift plus arrow to resize.
        </p>
      </div>

      <div className="grid gap-3 content-start">
        <ShelfPanel zone={zone} onError={setError} />
        {current
          ? <ContainerPanelForm
              key={current.id}
              zone={zone}
              container={current}
              onError={setError}
              onDone={() => { setSelected(null); router.refresh() }}
            />
          : <NewContainerForm zone={zone} onError={setError} />}
      </div>
    </div>
  )
}

function ShelfPanel({ zone, onError }: { zone: ZoneWithLayout; onError: (m: string) => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [, start] = useTransition()

  return (
    <section className="surface p-3">
      <h2 className="eyebrow mb-2">Shelves</h2>
      <ul className="mb-2 list-none p-0">
        {zone.shelves.map((s) => (
          <li key={s.id} className="rule flex items-center justify-between py-1.5 text-sm last:border-b-0">
            <span>{s.name}</span>
            <button
              className="muted text-xs underline"
              onClick={() => start(async () => {
                const res = await removeShelf({ id: s.id, zoneId: zone.id })
                if (!res.ok) onError(res.error); else router.refresh()
              })}
            >Remove</button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          start(async () => {
            const res = await addShelf({ zoneId: zone.id, name })
            if (!res.ok) onError(res.error)
            else { setName(''); router.refresh() }
          })
        }}
      >
        <input className="field" value={name} onChange={(e) => setName(e.target.value)}
               placeholder="Add a shelf row" aria-label="New shelf name" />
        <button className="btn shrink-0" type="submit">Add</button>
      </form>
    </section>
  )
}

type ContainerRow = ZoneWithLayout['shelves'][0]['containers'][0] & { shelfId: string }

function ContainerPanelForm({
  zone, container, onError, onDone,
}: {
  zone: ZoneWithLayout; container: ContainerRow
  onError: (m: string) => void; onDone: () => void
}) {
  const [label, setLabel] = useState(container.label)
  const [kind, setKind] = useState(container.kind)
  const [colorTag, setColorTag] = useState(container.color_tag ?? '')
  const [, start] = useTransition()

  return (
    <section className="surface p-3">
      <h2 className="eyebrow mb-2">Edit container</h2>
      <div className="grid gap-2">
        <input className="field" value={label} onChange={(e) => setLabel(e.target.value)}
               aria-label="Container label" />
        <select className="field" value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Kind">
          {CONTAINER_KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
        </select>
        <select className="field" value={colorTag}
                onChange={(e) => setColorTag(e.target.value)} aria-label="Category">
          <option value="">No category</option>
          {TAG_NAMES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="flex gap-2">
          <button
            className="btn primary flex-1"
            onClick={() => start(async () => {
              const res = await upsertContainer({
                id: container.id, shelfId: container.shelfId, zoneId: zone.id,
                label, kind, colStart: container.col_start, colSpan: container.col_span,
                colorTag: colorTag || null,
              })
              if (!res.ok) onError(res.error); else onDone()
            })}
          >Save</button>
          <button
            className="btn"
            onClick={() => start(async () => {
              const res = await removeContainer({ id: container.id, zoneId: zone.id })
              if (!res.ok) onError(res.error); else onDone()
            })}
          >Delete</button>
        </div>
      </div>
    </section>
  )
}

function NewContainerForm({ zone, onError }: { zone: ZoneWithLayout; onError: (m: string) => void }) {
  const router = useRouter()
  const [shelfId, setShelfId] = useState(zone.shelves[0]?.id ?? '')
  const [label, setLabel] = useState('')
  const [span, setSpan] = useState(4)
  const [, start] = useTransition()

  if (zone.shelves.length === 0) {
    return <p className="muted text-sm">Add a shelf row first.</p>
  }

  return (
    <section className="surface p-3">
      <h2 className="eyebrow mb-2">Add container</h2>
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const shelf = zone.shelves.find((s) => s.id === shelfId)
          // Drop it after whatever is already on the row.
          const nextCol = shelf
            ? shelf.containers.reduce((m, c) => Math.max(m, c.col_start + c.col_span), 0)
            : 0
          start(async () => {
            const res = await upsertContainer({
              shelfId, zoneId: zone.id, label,
              kind: 'bin', colStart: nextCol, colSpan: span,
            })
            if (!res.ok) onError(res.error)
            else { setLabel(''); router.refresh() }
          })
        }}
      >
        <select className="field" value={shelfId} onChange={(e) => setShelfId(e.target.value)}
                aria-label="Shelf">
          {zone.shelves.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input className="field" value={label} onChange={(e) => setLabel(e.target.value)}
               placeholder="Label, for example Bin A1a" aria-label="Container label" />
        <label className="eyebrow">Width, {span} of {zone.grid_cols} columns</label>
        <input type="range" min={1} max={zone.grid_cols} value={span}
               onChange={(e) => setSpan(Number(e.target.value))} aria-label="Column span" />
        <button className="btn primary" type="submit" disabled={!label.trim()}>Add container</button>
      </form>
    </section>
  )
}
