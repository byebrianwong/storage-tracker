import { describe, it, expect } from 'vitest'
import { validateShelf } from '@/lib/geometry/validateShelf'
import { layoutElevation } from '@/lib/elevation/layout'
import {
  DEMO_ZONES, DEMO_ITEMS, DEMO_PLAN_ZONES, DEMO_INDEX, DEMO_TOTAL_ITEMS,
} from './sample'

/**
 * The demo is the first thing a stranger sees, and it is hand written data
 * rather than anything the database validated. So hold it to the same rules the
 * real app enforces: no overlapping containers, polygons in range, counts that
 * match reality.
 */
describe('demo sample data', () => {
  it('has every zone from the mock', () => {
    expect(DEMO_ZONES).toHaveLength(9)
    expect(DEMO_ZONES.map((z) => z.name)).toEqual(expect.arrayContaining([
      'Entry closet', 'Primary closet', 'Under bed', 'Linen cabinet',
      'Office shelving', 'Media console', 'Kitchen uppers', 'Pantry',
      'Balcony deck box',
    ]))
  })

  it('never overlaps containers on a shelf', () => {
    for (const zone of DEMO_ZONES) {
      for (const shelf of zone.shelves) {
        const result = validateShelf(shelf.containers, zone.grid_cols)
        expect(result, `${zone.name} / ${shelf.name}`).toEqual({ ok: true })
      }
    }
  })

  it('keeps every polygon inside the plan', () => {
    for (const zone of DEMO_ZONES) {
      for (const [x, y] of zone.polygon) {
        expect(x, zone.name).toBeGreaterThanOrEqual(0)
        expect(x, zone.name).toBeLessThanOrEqual(1)
        expect(y, zone.name).toBeGreaterThanOrEqual(0)
        expect(y, zone.name).toBeLessThanOrEqual(1)
      }
    }
  })

  it('renders through the real elevation layout without collisions', () => {
    for (const zone of DEMO_ZONES) {
      const layout = layoutElevation(zone)
      for (const shelf of layout.shelves) {
        const sorted = [...shelf.containers].sort((a, b) => a.x - b.x)
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].x, `${zone.name} / ${shelf.name}`)
            .toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w)
        }
      }
    }
  })

  it('has items for every container, and counts that agree', () => {
    for (const zone of DEMO_ZONES) {
      for (const shelf of zone.shelves) {
        for (const container of shelf.containers) {
          const items = DEMO_ITEMS[container.id]
          expect(items, `${container.label} has no items entry`).toBeDefined()
          expect(items.length).toBe(container.item_count)
        }
      }
    }
  })

  it('agrees between the plan counts and the item lists', () => {
    const fromItems = Object.values(DEMO_ITEMS).reduce((n, list) => n + list.length, 0)
    const fromZones = DEMO_PLAN_ZONES.reduce((n, z) => n + z.itemCount, 0)
    expect(fromZones).toBe(fromItems)
    expect(DEMO_TOTAL_ITEMS).toBe(fromItems)
  })

  it('gives every item a unique id, so React keys are stable', () => {
    const ids = DEMO_INDEX.map((r) => r.item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('indexes every item with its full location path', () => {
    const items = Object.values(DEMO_ITEMS).reduce((n, l) => n + l.length, 0)
    expect(DEMO_INDEX).toHaveLength(items)
    for (const row of DEMO_INDEX) {
      expect(row.zoneName).toBeTruthy()
      expect(row.shelfName).toBeTruthy()
      expect(row.containerLabel).toBeTruthy()
    }
  })
})

/** Mirrors the filter in DemoApp, so the placeholder's promises actually hold. */
function search(term: string) {
  const t = term.trim().toLowerCase()
  if (!t) return []
  return DEMO_INDEX.filter(
    (row) => row.item.name.toLowerCase().includes(t) ||
      row.tag.toLowerCase().includes(t) ||
      row.zoneName.toLowerCase().includes(t) ||
      row.containerLabel.toLowerCase().includes(t),
  )
}

describe('demo search', () => {
  // The placeholder says: try "sleeping bag" or "camping". Both must work.
  it('finds the items the placeholder suggests', () => {
    const bag = search('sleeping bag')
    expect(bag.length).toBeGreaterThan(0)
    expect(bag[0].item.name).toBe('Sleeping bags')
    expect(bag[0].zoneName).toBe('Balcony deck box')

    expect(search('camping').length).toBeGreaterThan(0)
  })

  it('matches a zone name', () => {
    expect(search('pantry').map((r) => r.item.name))
      .toEqual(expect.arrayContaining(['Rice', 'Dried beans', 'Pasta']))
  })

  it('matches a category tag', () => {
    expect(search('docs').map((r) => r.item.name)).toContain('Passports')
  })

  it('returns nothing for a blank query', () => {
    expect(search('   ')).toEqual([])
  })
})
