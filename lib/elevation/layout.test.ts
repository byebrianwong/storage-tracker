import { describe, it, expect } from 'vitest'
import { layoutElevation, VIEW_W, BASE_ROW_H, LEFT_GUTTER, FRAME_PAD, CELL_INSET } from './layout'
import type { ZoneWithLayout } from '@/lib/types'

const container = (over: Partial<ZoneWithLayout['shelves'][0]['containers'][0]> = {}) => ({
  id: 'c1', shelf_id: 's1', label: 'Bin A1a', kind: 'bin' as const,
  col_start: 0, col_span: 4, color_tag: null, notes: null,
  capacity_hint: null, sort_order: 0, item_count: 3, ...over,
})

const zone = (shelves: ZoneWithLayout['shelves']): ZoneWithLayout => ({
  id: 'z1', floor_id: 'f1', name: 'Entry closet', code: 'A1', room_label: 'Entry',
  polygon: [[0, 0], [1, 0], [1, 1]], label_anchor: null, grid_cols: 12,
  notes: null, sort_order: 0, shelves,
})

const shelf = (over: Partial<ZoneWithLayout['shelves'][0]> = {}): ZoneWithLayout['shelves'][0] => ({
  id: 's1', zone_id: 'z1', name: 'Top shelf', row_index: 0, height_units: 1,
  containers: [container()], ...over,
})

describe('layoutElevation (section 6)', () => {
  it('is deterministic: same input, identical output', () => {
    const z = zone([shelf()])
    expect(layoutElevation(z)).toEqual(layoutElevation(z))
  })

  it('orders shelves by row_index, not array order', () => {
    const z = zone([
      shelf({ id: 'bottom', name: 'Floor', row_index: 2 }),
      shelf({ id: 'top', name: 'Top shelf', row_index: 0 }),
      shelf({ id: 'mid', name: 'Rod', row_index: 1 }),
    ])
    expect(layoutElevation(z).shelves.map((s) => s.id)).toEqual(['top', 'mid', 'bottom'])
  })

  it('scales row height by height_units', () => {
    const single = layoutElevation(zone([shelf({ height_units: 1 })]))
    const double = layoutElevation(zone([shelf({ height_units: 2 })]))
    expect(double.height - single.height).toBe(BASE_ROW_H)
  })

  it('computes total height from total row units', () => {
    const z = zone([
      shelf({ id: 'a', row_index: 0, height_units: 1 }),
      shelf({ id: 'b', row_index: 1, height_units: 2 }),
    ])
    const l = layoutElevation(z)
    expect(l.frame.h).toBe(3 * BASE_ROW_H + FRAME_PAD)
    expect(l.width).toBe(VIEW_W)
  })

  it('places a container from col_start, and spans col_span', () => {
    const l = layoutElevation(zone([shelf({
      containers: [container({ id: 'x', col_start: 3, col_span: 6 })],
    })]))
    const c = l.shelves[0].containers[0]
    const contentW = l.contentW
    expect(c.x).toBeCloseTo(LEFT_GUTTER + FRAME_PAD + (3 / 12) * contentW + CELL_INSET)
    expect(c.w).toBeCloseTo((6 / 12) * contentW - CELL_INSET * 2)
  })

  it('draws gaps as gaps: a half empty shelf stays half empty', () => {
    const l = layoutElevation(zone([shelf({
      containers: [
        container({ id: 'a', col_start: 0, col_span: 4 }),
        container({ id: 'b', col_start: 8, col_span: 4 }),
      ],
    })]))
    const [a, b] = l.shelves[0].containers
    // the untouched middle third stays empty rather than being packed away
    expect(b.x - (a.x + a.w)).toBeGreaterThan(l.contentW / 4)
  })

  it('honours a non default grid_cols', () => {
    const z = { ...zone([shelf({ containers: [container({ col_start: 0, col_span: 1 })] })]), grid_cols: 4 }
    const c = layoutElevation(z).shelves[0].containers[0]
    expect(c.w).toBeCloseTo(layoutElevation(z).contentW / 4 - CELL_INSET * 2)
  })

  it('never produces a negative width for a thin container', () => {
    const z = { ...zone([shelf({ containers: [container({ col_start: 0, col_span: 1 })] })]), grid_cols: 48 }
    expect(layoutElevation(z).shelves[0].containers[0].w).toBeGreaterThan(0)
  })

  it('handles a zone with no shelves', () => {
    const l = layoutElevation(zone([]))
    expect(l.shelves).toEqual([])
    expect(l.height).toBeGreaterThan(0)
  })

  // M3 acceptance: 3 shelves, 7 containers, no overlaps.
  it('lays out 3 shelves and 7 containers without overlapping boxes', () => {
    const l = layoutElevation(zone([
      shelf({ id: 's1', row_index: 0, name: 'Top shelf', containers: [
        container({ id: 'a', col_start: 0, col_span: 4 }),
        container({ id: 'b', col_start: 4, col_span: 4 }),
        container({ id: 'c', col_start: 8, col_span: 4 }),
      ]}),
      shelf({ id: 's2', row_index: 1, name: 'Hanging rod', containers: [
        container({ id: 'd', col_start: 0, col_span: 8 }),
        container({ id: 'e', col_start: 8, col_span: 4 }),
      ]}),
      shelf({ id: 's3', row_index: 2, name: 'Floor', containers: [
        container({ id: 'f', col_start: 0, col_span: 5 }),
        container({ id: 'g', col_start: 5, col_span: 7 }),
      ]}),
    ]))

    expect(l.shelves.flatMap((s) => s.containers)).toHaveLength(7)
    for (const s of l.shelves) {
      const sorted = [...s.containers].sort((p, q) => p.x - q.x)
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w)
      }
    }
    // rows must not collide vertically either
    const rows = l.shelves.map((s) => s.containers[0])
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].y).toBeGreaterThanOrEqual(rows[i - 1].y + rows[i - 1].h)
    }
  })
})
