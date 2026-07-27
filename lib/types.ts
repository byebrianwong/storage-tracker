import { z } from 'zod'

export const CONTAINER_KINDS = [
  'bin', 'drawer', 'box', 'basket', 'rod', 'hook', 'open_shelf', 'cabinet', 'other',
] as const
export type ContainerKind = (typeof CONTAINER_KINDS)[number]

/** A point in normalized plan coordinates. Both axes are 0..1. Section 5.2. */
export const PointSchema = z.tuple([z.number(), z.number()])
export type Point = [number, number]

export const PolygonSchema = z.array(PointSchema).min(3)
export type Polygon = Point[]

export const LabelAnchorSchema = z.object({
  x: z.number(),
  y: z.number(),
  anchor: z.enum(['start', 'middle', 'end']).default('start'),
})
export type LabelAnchor = z.infer<typeof LabelAnchorSchema>

export const ZoneSchema = z.object({
  id: z.uuid(),
  floor_id: z.uuid(),
  name: z.string().min(1),
  code: z.string().nullable(),
  room_label: z.string().nullable(),
  polygon: PolygonSchema,
  label_anchor: LabelAnchorSchema.nullable(),
  grid_cols: z.number().int().min(1).max(48),
  notes: z.string().nullable(),
  sort_order: z.number().int(),
})
export type Zone = z.infer<typeof ZoneSchema>

export const ShelfSchema = z.object({
  id: z.uuid(),
  zone_id: z.uuid(),
  name: z.string().min(1),
  row_index: z.number().int().min(0),
  height_units: z.number().int().min(1).max(4),
})
export type Shelf = z.infer<typeof ShelfSchema>

export const ContainerSchema = z.object({
  id: z.uuid(),
  shelf_id: z.uuid(),
  label: z.string().min(1),
  kind: z.enum(CONTAINER_KINDS),
  col_start: z.number().int().min(0),
  col_span: z.number().int().min(1),
  color_tag: z.string().nullable(),
  notes: z.string().nullable(),
  capacity_hint: z.number().int().nullable(),
  sort_order: z.number().int(),
})
export type Container = z.infer<typeof ContainerSchema>

export const ItemSchema = z.object({
  id: z.uuid(),
  household_id: z.uuid(),
  container_id: z.uuid().nullable(),
  name: z.string().min(1),
  quantity: z.number().int().min(0),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  photo_path: z.string().nullable(),
  deleted_at: z.string().nullable(),
  updated_at: z.string(),
})
export type Item = z.infer<typeof ItemSchema>

/** A zone with its shelves and containers, the unit the elevation renderer takes. */
export type ZoneWithLayout = Zone & {
  shelves: (Shelf & { containers: (Container & { item_count: number })[] })[]
}

/** The full location path shown on every search result. Section 8. */
export type LocationPath = {
  zone_id: string
  zone_name: string
  shelf_name: string
  container_id: string
  container_label: string
}

export type SearchHit = {
  item_id: string
  name: string
  quantity: number
  category: string | null
  rank: number
  location: LocationPath | null
}

/**
 * The canonical, order independent shape we hash for echo suppression.
 * Section 7.4 step 3. Keep this in sync with the outbound mapper.
 */
export const ItemSyncPayloadSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  location_page_id: z.string().nullable(),
  archived: z.boolean(),
})
export type ItemSyncPayload = z.infer<typeof ItemSyncPayloadSchema>

export const ContainerSyncPayloadSchema = z.object({
  name: z.string(),
  zone: z.string(),
  shelf: z.string(),
  kind: z.string(),
  app_id: z.uuid(),
})
export type ContainerSyncPayload = z.infer<typeof ContainerSyncPayloadSchema>

export type SyncEntity = 'item' | 'container'
export type SyncDirection = 'push' | 'pull'
export type SyncStatusValue = 'synced' | 'pending' | 'conflict' | 'error'

export type SyncJob = {
  id: string
  household_id: string
  direction: SyncDirection
  entity_type: SyncEntity
  entity_id: string | null
  notion_page_id: string | null
  op: 'upsert' | 'archive'
  attempts: number
}
