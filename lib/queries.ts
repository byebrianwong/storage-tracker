import 'server-only'
import { supabaseServer } from '@/lib/db/server'
import { PolygonSchema, type ZoneWithLayout } from '@/lib/types'
import type { PlanZone } from '@/components/plan/PlanCanvas'

/** The floor the plan view renders. v1 assumes one, see DECISIONS.md. */
export async function currentFloor(householdId: string) {
  const supabase = await supabaseServer()
  const { data } = await supabase
    .from('floors')
    .select('id, name, plan_path, plan_width, plan_height, homes!inner(household_id)')
    .eq('homes.household_id', householdId)
    .order('sort_order')
    .limit(1)
    .maybeSingle()
  return data
}

/** Signed URL for the private floorplans bucket. Section 5.1: one hour, server side. */
export async function planSignedUrl(planPath: string | null): Promise<string | null> {
  if (!planPath) return null
  const supabase = await supabaseServer()
  const { data } = await supabase.storage.from('floorplans').createSignedUrl(planPath, 3600)
  return data?.signedUrl ?? null
}

export async function zonesForPlan(floorId: string): Promise<PlanZone[]> {
  const supabase = await supabaseServer()
  const { data, error } = await supabase
    .from('zones')
    .select(`
      id, name, code, polygon, label_anchor,
      shelves ( id, containers ( id, color_tag, items ( id ) ) )
    `)
    .eq('floor_id', floorId)
    .order('sort_order')

  if (error) throw error

  return (data ?? []).map((z) => {
    const containers = (z.shelves ?? []).flatMap((s) => s.containers ?? [])
    const parsed = PolygonSchema.safeParse(z.polygon)
    return {
      id: z.id as string,
      name: z.name as string,
      code: (z.code as string | null) ?? null,
      // A malformed polygon must not blank the whole plan.
      polygon: parsed.success ? parsed.data : [[0, 0], [0.02, 0], [0.02, 0.02]],
      labelAnchor: (z.label_anchor as PlanZone['labelAnchor']) ?? null,
      itemCount: containers.reduce((n, c) => n + (c.items?.length ?? 0), 0),
      colorTag: containers.find((c) => c.color_tag)?.color_tag ?? null,
    }
  })
}

export async function zoneWithLayout(zoneId: string): Promise<ZoneWithLayout | null> {
  const supabase = await supabaseServer()
  const { data, error } = await supabase
    .from('zones')
    .select(`
      id, floor_id, name, code, room_label, polygon, label_anchor, grid_cols, notes, sort_order,
      shelves ( id, zone_id, name, row_index, height_units,
        containers ( id, shelf_id, label, kind, col_start, col_span, color_tag,
                     notes, capacity_hint, sort_order, items ( id ) ) )
    `)
    .eq('id', zoneId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const parsed = PolygonSchema.safeParse(data.polygon)

  return {
    id: data.id as string,
    floor_id: data.floor_id as string,
    name: data.name as string,
    code: data.code as string | null,
    room_label: data.room_label as string | null,
    polygon: parsed.success ? parsed.data : [[0, 0], [1, 0], [1, 1]],
    label_anchor: data.label_anchor as ZoneWithLayout['label_anchor'],
    grid_cols: data.grid_cols as number,
    notes: data.notes as string | null,
    sort_order: data.sort_order as number,
    shelves: (data.shelves ?? [])
      .sort((a, b) => (a.row_index as number) - (b.row_index as number))
      .map((s) => ({
        id: s.id as string,
        zone_id: s.zone_id as string,
        name: s.name as string,
        row_index: s.row_index as number,
        height_units: s.height_units as number,
        containers: (s.containers ?? [])
          .sort((a, b) => (a.col_start as number) - (b.col_start as number))
          .map((c) => ({
            id: c.id as string,
            shelf_id: c.shelf_id as string,
            label: c.label as string,
            kind: c.kind as ZoneWithLayout['shelves'][0]['containers'][0]['kind'],
            col_start: c.col_start as number,
            col_span: c.col_span as number,
            color_tag: c.color_tag as string | null,
            notes: c.notes as string | null,
            capacity_hint: c.capacity_hint as number | null,
            sort_order: c.sort_order as number,
            item_count: c.items?.length ?? 0,
          })),
      })),
  }
}

export async function itemsInContainer(containerId: string) {
  const supabase = await supabaseServer()
  const { data } = await supabase
    .from('items')
    .select('id, name, quantity')
    .eq('container_id', containerId)
    .is('deleted_at', null)
    .order('created_at')
  return data ?? []
}

/**
 * Section 7.5: rows created in Notion without a Location land in a lazily
 * created "Unsorted" container. The plan view badges them so they do not sit
 * there unnoticed.
 */
export async function unsortedCount(householdId: string) {
  const supabase = await supabaseServer()
  const { data } = await supabase
    .from('containers')
    .select('id, label, shelves!inner(zone_id)')
    .eq('label', 'Unsorted')
    .limit(1)
    .maybeSingle()

  if (!data) return { count: 0, zoneId: null as string | null, containerId: null as string | null }

  const { count } = await supabase
    .from('items')
    .select('id', { count: 'exact', head: true })
    .eq('container_id', data.id)
    .eq('household_id', householdId)
    .is('deleted_at', null)

  return {
    count: count ?? 0,
    zoneId: (data.shelves as unknown as { zone_id: string }).zone_id,
    containerId: data.id as string,
  }
}

/** Queue depth and last run, for the sync chip in section 9.1. */
export async function syncHealth(householdId: string) {
  const supabase = await supabaseServer()
  const [{ count: queued }, { count: conflicts }] = await Promise.all([
    supabase.from('sync_jobs').select('id', { count: 'exact', head: true })
      .eq('household_id', householdId).in('status', ['queued', 'running']),
    supabase.from('sync_conflicts').select('id', { count: 'exact', head: true })
      .eq('household_id', householdId).is('resolved_at', null),
  ])
  const { data: failed } = await supabase.from('sync_jobs')
    .select('id').eq('household_id', householdId).eq('status', 'failed').limit(1)

  const state: 'ok' | 'pending' | 'error' =
    (failed?.length ?? 0) > 0 || (conflicts ?? 0) > 0 ? 'error'
      : (queued ?? 0) > 0 ? 'pending' : 'ok'

  return { state, queued: queued ?? 0, conflicts: conflicts ?? 0 }
}
