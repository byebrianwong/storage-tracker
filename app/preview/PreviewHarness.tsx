'use client'

import { useState } from 'react'
import { ElevationCanvas } from '@/components/elevation/ElevationCanvas'
import { PlanCanvas, type PlanZone } from '@/components/plan/PlanCanvas'
import { SKINS, type SkinId } from '@/lib/theme/tags'
import type { ZoneWithLayout } from '@/lib/types'

const container = (
  id: string, label: string, tag: string | null, colStart: number, colSpan: number, items: number,
) => ({
  id, shelf_id: '', label, kind: 'bin' as const,
  col_start: colStart, col_span: colSpan, color_tag: tag,
  notes: null, capacity_hint: null, sort_order: 0, item_count: items,
})

/** The entry closet from the design mock: 3 shelves, 7 containers. */
const ZONE: ZoneWithLayout = {
  id: 'entry-closet', floor_id: 'f1', name: 'Entry closet', code: 'A1',
  room_label: 'Entry', polygon: [[0.05, 0.45], [0.21, 0.45], [0.21, 0.51], [0.05, 0.51]],
  label_anchor: null, grid_cols: 12, notes: null, sort_order: 0,
  shelves: [
    { id: 's1', zone_id: 'entry-closet', name: 'Top shelf', row_index: 0, height_units: 1,
      containers: [
        container('a', 'Bin A1a', 'Winter', 0, 4, 3),
        container('b', 'Bin A1b', 'Beach', 4, 4, 3),
        container('c', 'Bin A1c', 'Dog', 8, 4, 3),
      ] },
    { id: 's2', zone_id: 'entry-closet', name: 'Hanging rod', row_index: 1, height_units: 1,
      containers: [
        container('d', 'Rod', 'Coats', 0, 8, 2),
        container('e', 'Hooks', 'Daily', 8, 4, 2),
      ] },
    { id: 's3', zone_id: 'entry-closet', name: 'Floor', row_index: 2, height_units: 1,
      containers: [
        container('f', 'Left', 'Cleaning', 0, 5, 2),
        // Deliberate gap at column 10-11: a half empty shelf draws half empty.
        container('g', 'Right', 'Shoes', 5, 5, 2),
      ] },
  ],
}

const ZONES: PlanZone[] = [
  { id: 'entry-closet', name: 'Entry closet', code: 'A1', itemCount: 17, colorTag: 'Winter',
    polygon: [[0.05, 0.45], [0.21, 0.45], [0.21, 0.51], [0.05, 0.51]], labelAnchor: null },
  { id: 'primary-closet', name: 'Primary closet', code: 'B1', itemCount: 12, colorTag: 'Bedding',
    polygon: [[0.05, 0.06], [0.20, 0.06], [0.20, 0.12], [0.05, 0.12]], labelAnchor: null },
  { id: 'under-bed', name: 'Under bed', code: 'B2', itemCount: 8, colorTag: 'Sports',
    polygon: [[0.24, 0.23], [0.40, 0.23], [0.40, 0.38], [0.24, 0.38]], labelAnchor: null },
  { id: 'linen', name: 'Linen cabinet', code: 'C1', itemCount: 9, colorTag: 'Medicine',
    polygon: [[0.43, 0.06], [0.50, 0.06], [0.50, 0.20], [0.43, 0.20]], labelAnchor: null },
  // Deliberately thin, to exercise the leader line and the expanded touch target.
  { id: 'pantry', name: 'Pantry', code: 'F2', itemCount: 14, colorTag: 'Bulk',
    polygon: [[0.91, 0.45], [0.95, 0.45], [0.95, 0.64], [0.91, 0.64]], labelAnchor: null },
  { id: 'kitchen-uppers', name: 'Kitchen uppers', code: 'F1', itemCount: 11, colorTag: 'Baking',
    polygon: [[0.65, 0.44], [0.88, 0.44], [0.88, 0.48], [0.65, 0.48]], labelAnchor: null },
]

/** A stand-in plan drawing, inlined so the harness needs no uploaded asset. */
const PLAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 472" width="600" height="472">
  <rect width="600" height="472" fill="#FDFEFE"/>
  <g stroke="#16232E" stroke-width="3" fill="none">
    <path d="M20 20 H580 V400 H20 Z"/><path d="M20 200 H580"/><path d="M250 20 V200"/>
    <path d="M360 20 V200"/><path d="M130 200 V400"/><path d="M380 200 V400"/>
  </g>
  <g stroke="#FDFEFE" stroke-width="5">
    <path d="M60 200 H92"/><path d="M292 200 H322"/><path d="M420 200 H452"/><path d="M52 400 H92"/>
  </g>
  <rect x="380" y="400" width="200" height="50" fill="none" stroke="#9BAAB4"
        stroke-width="1.4" stroke-dasharray="5 4"/>
  <g font-family="monospace" font-size="8.5" letter-spacing="1.2" fill="#6C7B86">
    <text x="34" y="192">BEDROOM</text><text x="258" y="192">BATH</text><text x="368" y="192">OFFICE</text>
    <text x="34" y="392">ENTRY</text><text x="262" y="392">LIVING / DINING</text>
    <text x="388" y="392">KITCHEN</text><text x="388" y="462">BALCONY</text>
  </g>
</svg>`

const PLAN_URL = `data:image/svg+xml;utf8,${encodeURIComponent(PLAN_SVG)}`

export function PreviewHarness() {
  const [skin, setSkin] = useState<SkinId>('a')
  const [selectedContainer, setSelectedContainer] = useState<string | null>('b')
  const [selectedZone, setSelectedZone] = useState<string | null>('entry-closet')
  const [searching, setSearching] = useState(false)

  const hits = searching ? new Set(['c', 'pantry']) : undefined

  return (
    <div data-skin={skin} style={{ background: 'var(--paper)', color: 'var(--ink)', minHeight: '100dvh' }}>
      <div className="mx-auto max-w-6xl px-4 py-6">
        <p className="eyebrow mb-1">Development preview</p>
        <h1 className="brand mb-4">Renderer harness</h1>

        <div className="mb-5 flex flex-wrap items-center gap-2">
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
          <button
            className="btn"
            style={{ minHeight: 34, padding: '4px 10px', fontSize: 12 }}
            aria-pressed={searching}
            onClick={() => setSearching((v) => !v)}
          >
            {searching ? 'Clear search highlight' : 'Simulate search hit'}
          </button>
        </div>

        <p className="muted mb-6 max-w-2xl text-sm">{SKINS.find((s) => s.id === skin)?.blurb}</p>

        <div className="grid gap-6 lg:grid-cols-2">
          <section>
            <p className="eyebrow mb-2">Floor plan</p>
            <PlanCanvas
              planUrl={PLAN_URL}
              planWidth={600}
              planHeight={472}
              zones={ZONES}
              selectedZoneId={selectedZone}
              highlightedIds={hits}
              onSelect={setSelectedZone}
            />
          </section>

          <section>
            <p className="eyebrow mb-2">Elevation, {ZONE.name}</p>
            <ElevationCanvas
              zone={ZONE}
              selectedContainerId={selectedContainer}
              highlightedIds={hits}
              onSelect={setSelectedContainer}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
