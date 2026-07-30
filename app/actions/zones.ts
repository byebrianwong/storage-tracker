'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { supabaseServer, currentHouseholdId } from '@/lib/db/server'
import { LabelAnchorSchema } from '@/lib/types'
import type { ActionResult } from '@/app/actions/items'

/**
 * Zone geometry and metadata. Sections 5.2 and 5.3.
 *
 * RLS scopes every one of these to the caller's household through
 * `floor_is_visible`, so none of them filters by household by hand. What they
 * do enforce is the coordinate contract: a polygon that leaves 0..1 or drops
 * below three points is not storable, because the plan renderer trusts stored
 * geometry completely and a bad row would be invisible or would blank the plan.
 */

/**
 * Both axes normalized. This is stricter than `PointSchema` in lib/types, which
 * only asks for numbers: nothing outside this module is allowed to widen it.
 */
const NormalizedPoint = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])

const NormalizedPolygon = z
  .array(NormalizedPoint)
  .min(3, 'A zone needs at least three corners')
  // A polygon this big is a runaway drag, not a storage area, and jsonb has no
  // opinion about size.
  .max(200, 'That shape has too many points')

const Name = z.string().trim().min(1, 'Give the zone a name').max(80)
const RoomLabel = z.string().trim().max(40).nullish()
const Code = z.string().trim().max(12).nullish()

/** Empty strings arrive from untouched inputs; they mean "unset", not "". */
function orNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

const CreateZone = z.object({
  floorId: z.uuid(),
  name: Name,
  roomLabel: RoomLabel,
  code: Code,
  polygon: NormalizedPolygon,
  labelAnchor: LabelAnchorSchema.nullish(),
})

export async function createZone(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = CreateZone.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid zone' }
  }
  const { floorId, name, roomLabel, code, polygon, labelAnchor } = parsed.data

  const householdId = await currentHouseholdId()
  if (!householdId) return { ok: false, error: 'Not signed in' }

  const supabase = await supabaseServer()

  // Append rather than collide: sort_order drives the plan view's z order and
  // two zones sharing one is a coin flip on every render.
  const { data: last } = await supabase
    .from('zones')
    .select('sort_order')
    .eq('floor_id', floorId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data, error } = await supabase
    .from('zones')
    .insert({
      floor_id: floorId,
      name,
      room_label: orNull(roomLabel),
      code: orNull(code),
      polygon,
      label_anchor: labelAnchor ?? null,
      sort_order: ((last?.sort_order as number | undefined) ?? -1) + 1,
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }

  revalidatePath('/plan')
  revalidatePath('/setup/plan')
  return { ok: true, data: { id: data.id as string } }
}

const UpdateZonePolygon = z.object({
  id: z.uuid(),
  polygon: NormalizedPolygon,
})

/** Geometry only. Called on every drag end and every keyboard nudge commit. */
export async function updateZonePolygon(input: unknown): Promise<ActionResult> {
  const parsed = UpdateZonePolygon.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid shape' }
  }

  const supabase = await supabaseServer()
  const { error } = await supabase
    .from('zones')
    .update({ polygon: parsed.data.polygon })
    .eq('id', parsed.data.id)

  if (error) return { ok: false, error: error.message }

  revalidatePath('/plan')
  revalidatePath('/setup/plan')
  return { ok: true, data: undefined }
}

const UpdateZoneMeta = z.object({
  id: z.uuid(),
  name: Name.optional(),
  roomLabel: RoomLabel,
  code: Code,
  labelAnchor: LabelAnchorSchema.nullish(),
})

/** Section 5.3's inline form: name, room label, short code. */
export async function updateZoneMeta(input: unknown): Promise<ActionResult> {
  const parsed = UpdateZoneMeta.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid zone' }
  }
  const { id, name, roomLabel, code, labelAnchor } = parsed.data

  // Undefined means "not in this form"; null means "clear it". Only send keys
  // the caller actually supplied, or a rename would wipe the room label.
  const patch: Record<string, unknown> = {}
  if (name !== undefined) patch.name = name
  if (roomLabel !== undefined) patch.room_label = orNull(roomLabel)
  if (code !== undefined) patch.code = orNull(code)
  if (labelAnchor !== undefined) patch.label_anchor = labelAnchor ?? null
  if (Object.keys(patch).length === 0) return { ok: true, data: undefined }

  const supabase = await supabaseServer()
  const { error } = await supabase.from('zones').update(patch).eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/plan')
  revalidatePath('/setup/plan')
  return { ok: true, data: undefined }
}

/**
 * Hard delete, unlike items.
 *
 * A zone is layout, not inventory: it carries no Notion link and nothing
 * outside the plan references it. Its shelves, containers and items cascade,
 * so the editor has to warn before calling this when the zone is not empty.
 */
export async function deleteZone(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid zone' }

  const supabase = await supabaseServer()
  const { error } = await supabase.from('zones').delete().eq('id', parsed.data.id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/plan')
  revalidatePath('/setup/plan')
  return { ok: true, data: undefined }
}
