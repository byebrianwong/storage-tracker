import type { ZoneWithLayout } from '@/lib/types'
import type { PlanZone } from '@/components/plan/PlanCanvas'

/**
 * The condo from the design mock, as data.
 *
 * Used by the public demo. It never touches the database, so a stranger can see
 * the whole app working without an account and without us provisioning anything
 * for them.
 */

export type DemoItem = { id: string; name: string; quantity: number }

type Spec = {
  id: string
  name: string
  code: string
  room: string
  /** Normalized 0..1 rectangle on the plan: [x, y, w, h]. */
  rect: [number, number, number, number]
  shelves: { name: string; boxes: { label: string; tag: string; span: number; items: string[] }[] }[]
}

const SPECS: Spec[] = [
  { id: 'entry-closet', name: 'Entry closet', code: 'A1', room: 'Entry',
    rect: [0.047, 0.449, 0.157, 0.059], shelves: [
      { name: 'Top shelf', boxes: [
        { label: 'Bin A1a', tag: 'Winter', span: 4, items: ['Puffer jackets', 'Wool hats', 'Snow gloves'] },
        { label: 'Bin A1b', tag: 'Beach', span: 4, items: ['Beach towels', 'Sun hats', 'Collapsible cooler'] },
        { label: 'Bin A1c', tag: 'Dog', span: 4, items: ['Spare leash', 'Dog life vest', 'Travel bowl'] },
      ]},
      { name: 'Hanging rod', boxes: [
        { label: 'Rod', tag: 'Coats', span: 8, items: ['Rain shells', 'Guest coats'] },
        { label: 'Hooks', tag: 'Daily', span: 4, items: ['Dog harness', 'Tote bags'] },
      ]},
      { name: 'Floor', boxes: [
        { label: 'Left', tag: 'Cleaning', span: 5, items: ['Vacuum', 'Swiffer refills'] },
        { label: 'Right', tag: 'Shoes', span: 7, items: ['Rain boots', 'Hiking boots'] },
      ]},
    ]},

  { id: 'primary-closet', name: 'Primary closet', code: 'B1', room: 'Bedroom',
    rect: [0.047, 0.059, 0.15, 0.055], shelves: [
      { name: 'Shelf 2', boxes: [
        { label: 'Bin B1a', tag: 'Bedding', span: 6, items: ['Spare duvet', 'Flannel sheet set', 'Mattress protector'] },
        { label: 'Bin B1b', tag: 'Luggage', span: 6, items: ['Packing cubes', 'Travel adapters'] },
      ]},
      { name: 'Shelf 1', boxes: [
        { label: 'Bin B1c', tag: 'Docs', span: 4, items: ['Tax folders 2019 to 2024', 'Passports', 'Car title'] },
        { label: 'Open', tag: 'Spare', span: 8, items: ['Folded sweaters', 'Gift bags'] },
      ]},
    ]},

  { id: 'under-bed', name: 'Under bed', code: 'B2', room: 'Bedroom',
    rect: [0.233, 0.233, 0.167, 0.148], shelves: [
      { name: 'Left drawer', boxes: [
        { label: 'Drawer 1', tag: 'Bedding', span: 6, items: ['Summer quilt', 'Extra pillows'] },
        { label: 'Drawer 2', tag: 'Sports', span: 6, items: ['Yoga mats', 'Resistance bands'] },
      ]},
    ]},

  { id: 'linen', name: 'Linen cabinet', code: 'C1', room: 'Bath',
    rect: [0.43, 0.059, 0.073, 0.14], shelves: [
      { name: 'Upper', boxes: [
        { label: 'Basket', tag: 'Medicine', span: 6, items: ['First aid kit', 'Thermometer', 'Cold medicine'] },
        { label: 'Stack', tag: 'Bedding', span: 6, items: ['Bath towels', 'Hand towels'] },
      ]},
      { name: 'Lower', boxes: [
        { label: 'Bin C1a', tag: 'Paper', span: 12, items: ['Toilet paper bulk', 'Tissue boxes'] },
      ]},
    ]},

  { id: 'office-shelf', name: 'Office shelving', code: 'D1', room: 'Office',
    rect: [0.913, 0.064, 0.04, 0.339], shelves: [
      { name: 'Shelf 3', boxes: [
        { label: 'Box D1a', tag: 'Cables', span: 4, items: ['USB C cables', 'Old chargers', 'HDMI'] },
        { label: 'Box D1b', tag: 'Photos', span: 4, items: ['Photo prints', 'Negatives'] },
        { label: 'Box D1c', tag: 'Docs', span: 4, items: ['Warranty binder', 'Manuals'] },
      ]},
      { name: 'Shelf 2', boxes: [
        { label: 'Open', tag: 'Games', span: 7, items: ['Board games', 'Card decks'] },
        { label: 'Box D1d', tag: 'Spare', span: 5, items: ['Label maker', 'Notebooks'] },
      ]},
    ]},

  { id: 'media', name: 'Media console', code: 'E1', room: 'Living',
    rect: [0.233, 0.767, 0.187, 0.059], shelves: [
      { name: 'Cabinet', boxes: [
        { label: 'Left door', tag: 'Cables', span: 6, items: ['Power strips', 'Remote batteries'] },
        { label: 'Right door', tag: 'Games', span: 6, items: ['Switch dock', 'Controllers'] },
      ]},
    ]},

  { id: 'kitchen-uppers', name: 'Kitchen uppers', code: 'F1', room: 'Kitchen',
    rect: [0.653, 0.436, 0.233, 0.047], shelves: [
      { name: 'Top shelf', boxes: [
        { label: 'Cab 1', tag: 'Baking', span: 4, items: ['Stand mixer bowl', 'Cake pans', 'Piping tips'] },
        { label: 'Cab 2', tag: 'Spare', span: 4, items: ['Party plates', 'Serving platters'] },
        { label: 'Cab 3', tag: 'Bulk', span: 4, items: ['Mason jars', 'Thermoses'] },
      ]},
    ]},

  { id: 'pantry', name: 'Pantry', code: 'F2', room: 'Kitchen',
    rect: [0.913, 0.449, 0.04, 0.195], shelves: [
      { name: 'Shelf 3', boxes: [
        { label: 'Bin F2a', tag: 'Bulk', span: 6, items: ['Rice', 'Dried beans', 'Pasta'] },
        { label: 'Bin F2b', tag: 'Baking', span: 6, items: ['Flour', 'Sugar', 'Sprinkles'] },
      ]},
      { name: 'Shelf 1', boxes: [
        { label: 'Floor', tag: 'Cleaning', span: 12, items: ['Paper towels', 'Dish soap refills', 'Trash bags'] },
      ]},
    ]},

  { id: 'deck-box', name: 'Balcony deck box', code: 'G1', room: 'Balcony',
    rect: [0.663, 0.864, 0.153, 0.072], shelves: [
      { name: 'Deck box', boxes: [
        { label: 'Left half', tag: 'Camping', span: 6, items: ['Sleeping bags', 'Camp stove', 'Headlamps'] },
        { label: 'Right half', tag: 'Garden', span: 6, items: ['Potting soil', 'Hand trowel', 'Plant food'] },
      ]},
    ]},
]

function rectToPolygon([x, y, w, h]: [number, number, number, number]): [number, number][] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
}

export const DEMO_ZONES: ZoneWithLayout[] = SPECS.map((spec) => ({
  id: spec.id,
  floor_id: 'demo-floor',
  name: spec.name,
  code: spec.code,
  room_label: spec.room,
  polygon: rectToPolygon(spec.rect),
  label_anchor: null,
  grid_cols: 12,
  notes: null,
  sort_order: 0,
  shelves: spec.shelves.map((shelf, si) => {
    let col = 0
    return {
      id: `${spec.id}-s${si}`,
      zone_id: spec.id,
      name: shelf.name,
      row_index: si,
      height_units: 1,
      containers: shelf.boxes.map((box, bi) => {
        const start = col
        col += box.span
        return {
          id: `${spec.id}-s${si}-c${bi}`,
          shelf_id: `${spec.id}-s${si}`,
          label: box.label,
          kind: 'bin' as const,
          col_start: start,
          col_span: box.span,
          color_tag: box.tag,
          notes: null,
          capacity_hint: null,
          sort_order: bi,
          item_count: box.items.length,
        }
      }),
    }
  }),
}))

/** container id -> its items. */
export const DEMO_ITEMS: Record<string, DemoItem[]> = Object.fromEntries(
  SPECS.flatMap((spec) =>
    spec.shelves.flatMap((shelf, si) =>
      shelf.boxes.map((box, bi) => [
        `${spec.id}-s${si}-c${bi}`,
        box.items.map((name, i) => ({ id: `${spec.id}-${si}-${bi}-${i}`, name, quantity: 1 })),
      ]),
    ),
  ),
)

export const DEMO_PLAN_ZONES: PlanZone[] = DEMO_ZONES.map((z) => ({
  id: z.id,
  name: z.name,
  code: z.code,
  polygon: z.polygon,
  labelAnchor: null,
  itemCount: z.shelves.reduce(
    (n, s) => n + s.containers.reduce((m, c) => m + c.item_count, 0), 0),
  colorTag: z.shelves[0]?.containers[0]?.color_tag ?? null,
}))

export const DEMO_TOTAL_ITEMS = DEMO_PLAN_ZONES.reduce((n, z) => n + z.itemCount, 0)

/** Flattened for the demo's client side search. */
export const DEMO_INDEX = DEMO_ZONES.flatMap((zone) =>
  zone.shelves.flatMap((shelf) =>
    shelf.containers.flatMap((container) =>
      (DEMO_ITEMS[container.id] ?? []).map((item) => ({
        item,
        zoneId: zone.id,
        zoneName: zone.name,
        shelfName: shelf.name,
        containerId: container.id,
        containerLabel: container.label,
        tag: container.color_tag ?? '',
      })),
    ),
  ),
)

/** A stand-in floor plan, inlined so the demo needs no uploaded asset. */
const PLAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 472" width="600" height="472">
  <rect width="600" height="472" fill="#FDFEFE"/>
  <g stroke="#16232E" stroke-width="3" fill="none">
    <path d="M20 20 H580 V400 H20 Z"/><path d="M20 200 H580"/><path d="M250 20 V200"/>
    <path d="M360 20 V200"/><path d="M130 200 V400"/><path d="M380 200 V400"/>
  </g>
  <g stroke="#FDFEFE" stroke-width="5">
    <path d="M60 200 H92"/><path d="M292 200 H322"/><path d="M420 200 H452"/><path d="M52 400 H92"/>
  </g>
  <g stroke="#9BAAB4" stroke-width="1" fill="none">
    <path d="M60 200 A32 32 0 0 1 92 168"/><path d="M292 200 A30 30 0 0 1 322 170"/>
    <path d="M420 200 A32 32 0 0 1 452 168"/><path d="M52 400 A40 40 0 0 0 92 360"/>
  </g>
  <rect x="380" y="400" width="200" height="50" fill="none" stroke="#9BAAB4"
        stroke-width="1.4" stroke-dasharray="5 4"/>
  <g font-family="monospace" font-size="8.5" letter-spacing="1.2" fill="#6C7B86">
    <text x="34" y="192">BEDROOM</text><text x="258" y="192">BATH</text><text x="368" y="192">OFFICE</text>
    <text x="34" y="392">ENTRY</text><text x="262" y="392">LIVING / DINING</text>
    <text x="388" y="392">KITCHEN</text><text x="388" y="462">BALCONY</text>
  </g>
</svg>`

export const DEMO_PLAN_URL = `data:image/svg+xml;utf8,${encodeURIComponent(PLAN_SVG)}`
export const DEMO_PLAN_SIZE = { width: 600, height: 472 }
