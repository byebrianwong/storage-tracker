'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { supabaseServer, currentHouseholdId } from '@/lib/db/server'
import { dispatchDrain } from '@/lib/sync/dispatch'

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

const AddItem = z.object({
  containerId: z.uuid(),
  name: z.string().trim().min(1, 'Give the item a name').max(200),
  category: z.string().trim().max(80).nullish(),
  tags: z.array(z.string().trim().min(1)).max(20).default([]),
  quantity: z.coerce.number().int().min(0).max(9999).default(1),
})

export async function addItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = AddItem.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid item' }
  }
  const { containerId, name, category, tags, quantity } = parsed.data

  const supabase = await supabaseServer()
  const householdId = await currentHouseholdId()
  if (!householdId) return { ok: false, error: 'Not signed in' }

  const { data, error } = await supabase
    .from('items')
    .insert({
      household_id: householdId,
      container_id: containerId,
      name,
      category: category ?? null,
      tags,
      quantity,
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }

  dispatchDrain()
  revalidatePath('/plan')
  return { ok: true, data: { id: data.id as string } }
}

const UpdateItem = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  quantity: z.coerce.number().int().min(0).max(9999).optional(),
  category: z.string().trim().max(80).nullish(),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
  notes: z.string().trim().max(2000).nullish(),
})

export async function updateItem(input: unknown): Promise<ActionResult> {
  const parsed = UpdateItem.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid update' }
  }
  const { id, ...patch } = parsed.data
  const supabase = await supabaseServer()

  const { error } = await supabase.from('items').update(patch).eq('id', id)
  if (error) return { ok: false, error: error.message }

  dispatchDrain()
  revalidatePath('/plan')
  return { ok: true, data: undefined }
}

/** Soft delete. Section 7.5: never hard delete, the Notion page is archived instead. */
export async function deleteItem(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid item' }

  const supabase = await supabaseServer()
  const { error } = await supabase
    .from('items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', parsed.data.id)

  if (error) return { ok: false, error: error.message }

  dispatchDrain()
  revalidatePath('/plan')
  return { ok: true, data: undefined }
}

const MoveContents = z.object({ from: z.uuid(), to: z.uuid() })

/** Section 1: "Reorganize". Moves every live item from one container to another. */
export async function moveContents(input: unknown): Promise<ActionResult<{ moved: number }>> {
  const parsed = MoveContents.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Pick a destination container' }
  const { from, to } = parsed.data
  if (from === to) return { ok: false, error: 'That is the same container' }

  const supabase = await supabaseServer()
  const { data, error } = await supabase
    .from('items')
    .update({ container_id: to })
    .eq('container_id', from)
    .is('deleted_at', null)
    .select('id')

  if (error) return { ok: false, error: error.message }

  dispatchDrain()
  revalidatePath('/plan')
  return { ok: true, data: { moved: data?.length ?? 0 } }
}

const MoveItem = z.object({ id: z.uuid(), containerId: z.uuid() })

export async function moveItem(input: unknown): Promise<ActionResult> {
  const parsed = MoveItem.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Pick a destination container' }

  const supabase = await supabaseServer()
  const { error } = await supabase
    .from('items')
    .update({ container_id: parsed.data.containerId })
    .eq('id', parsed.data.id)

  if (error) return { ok: false, error: error.message }

  dispatchDrain()
  revalidatePath('/plan')
  return { ok: true, data: undefined }
}
