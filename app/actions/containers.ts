'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { supabaseServer } from '@/lib/db/server'
import { dispatchDrain } from '@/lib/sync/dispatch'
import { validateShelf } from '@/lib/geometry/validateShelf'
import { CONTAINER_KINDS } from '@/lib/types'
import type { ActionResult } from './items'

const AddShelf = z.object({
  zoneId: z.uuid(),
  name: z.string().trim().min(1, 'Name the shelf').max(80),
  heightUnits: z.coerce.number().int().min(1).max(4).default(1),
})

export async function addShelf(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = AddShelf.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid shelf' }

  const supabase = await supabaseServer()
  const { data: rows } = await supabase.from('shelves')
    .select('row_index').eq('zone_id', parsed.data.zoneId)
    .order('row_index', { ascending: false }).limit(1)

  const nextIndex = rows?.length ? (rows[0].row_index as number) + 1 : 0

  const { data, error } = await supabase.from('shelves').insert({
    zone_id: parsed.data.zoneId,
    name: parsed.data.name,
    row_index: nextIndex,
    height_units: parsed.data.heightUnits,
  }).select('id').single()

  if (error) return { ok: false, error: error.message }
  revalidatePath(`/zone/${parsed.data.zoneId}`)
  return { ok: true, data: { id: data.id as string } }
}

export async function removeShelf(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid(), zoneId: z.uuid() }).safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid shelf' }

  const supabase = await supabaseServer()
  const { error } = await supabase.from('shelves').delete().eq('id', parsed.data.id)
  if (error) return { ok: false, error: error.message }

  dispatchDrain()
  revalidatePath(`/zone/${parsed.data.zoneId}`)
  return { ok: true, data: undefined }
}

const UpsertContainer = z.object({
  id: z.uuid().optional(),
  shelfId: z.uuid(),
  zoneId: z.uuid(),
  label: z.string().trim().min(1, 'Give the container a label').max(80),
  kind: z.enum(CONTAINER_KINDS).default('bin'),
  colStart: z.coerce.number().int().min(0),
  colSpan: z.coerce.number().int().min(1),
  colorTag: z.string().trim().max(40).nullish(),
})

/**
 * Section 6. Overlap is enforced by a database exclusion constraint, but we
 * validate first so the editor can say which container is in the way rather
 * than surfacing a constraint name.
 */
export async function upsertContainer(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = UpsertContainer.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid container' }
  }
  const { id, shelfId, zoneId, label, kind, colStart, colSpan, colorTag } = parsed.data

  const supabase = await supabaseServer()

  const { data: zone } = await supabase.from('zones')
    .select('grid_cols').eq('id', zoneId).maybeSingle()
  const gridCols = (zone?.grid_cols as number) ?? 12

  const { data: siblings } = await supabase.from('containers')
    .select('id, col_start, col_span').eq('shelf_id', shelfId)

  const proposed = [
    ...(siblings ?? []).filter((c) => c.id !== id).map((c) => ({
      id: c.id as string, col_start: c.col_start as number, col_span: c.col_span as number,
    })),
    { id: id ?? 'new', col_start: colStart, col_span: colSpan },
  ]

  const check = validateShelf(proposed, gridCols)
  if (!check.ok) return { ok: false, error: check.errors[0] }

  const row = {
    shelf_id: shelfId, label, kind,
    col_start: colStart, col_span: colSpan,
    color_tag: colorTag ?? null,
  }

  const { data, error } = id
    ? await supabase.from('containers').update(row).eq('id', id).select('id').single()
    : await supabase.from('containers').insert(row).select('id').single()

  if (error) {
    // Belt and braces: the constraint fired even though validation passed.
    if (error.message.includes('containers_no_overlap')) {
      return { ok: false, error: 'That overlaps another container on this shelf.' }
    }
    return { ok: false, error: error.message }
  }

  dispatchDrain()
  revalidatePath(`/zone/${zoneId}`)
  return { ok: true, data: { id: data.id as string } }
}

export async function removeContainer(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid(), zoneId: z.uuid() }).safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid container' }

  const supabase = await supabaseServer()
  const { count } = await supabase.from('items')
    .select('id', { count: 'exact', head: true })
    .eq('container_id', parsed.data.id).is('deleted_at', null)

  if ((count ?? 0) > 0) {
    return { ok: false, error: `Move the ${count} items out first.` }
  }

  const { error } = await supabase.from('containers').delete().eq('id', parsed.data.id)
  if (error) return { ok: false, error: error.message }

  dispatchDrain()
  revalidatePath(`/zone/${parsed.data.zoneId}`)
  return { ok: true, data: undefined }
}

/** Move a container to a different shelf and/or column. Section 1, "Reorganize". */
export async function moveContainer(input: unknown): Promise<ActionResult> {
  const parsed = z.object({
    id: z.uuid(), zoneId: z.uuid(), shelfId: z.uuid(),
    colStart: z.coerce.number().int().min(0),
    colSpan: z.coerce.number().int().min(1),
  }).safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid move' }

  const supabase = await supabaseServer()
  const { data: zone } = await supabase.from('zones')
    .select('grid_cols').eq('id', parsed.data.zoneId).maybeSingle()
  const gridCols = (zone?.grid_cols as number) ?? 12

  const { data: siblings } = await supabase.from('containers')
    .select('id, col_start, col_span').eq('shelf_id', parsed.data.shelfId)

  const check = validateShelf([
    ...(siblings ?? []).filter((c) => c.id !== parsed.data.id).map((c) => ({
      id: c.id as string, col_start: c.col_start as number, col_span: c.col_span as number,
    })),
    { id: parsed.data.id, col_start: parsed.data.colStart, col_span: parsed.data.colSpan },
  ], gridCols)
  if (!check.ok) return { ok: false, error: check.errors[0] }

  const { error } = await supabase.from('containers').update({
    shelf_id: parsed.data.shelfId,
    col_start: parsed.data.colStart,
    col_span: parsed.data.colSpan,
  }).eq('id', parsed.data.id)

  if (error) return { ok: false, error: error.message }

  dispatchDrain()
  revalidatePath(`/zone/${parsed.data.zoneId}`)
  return { ok: true, data: undefined }
}
