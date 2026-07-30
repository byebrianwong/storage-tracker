'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { supabaseServer } from '@/lib/db/server'
import type { ActionResult } from './items'

const Request = z.object({
  email: z.email('That does not look like an email address').trim().toLowerCase(),
  note: z.string().trim().max(500).optional(),
})

/**
 * Anyone may ask for access, signed in or not. The table grants insert to anon
 * and authenticated but no select, so a caller can add to the queue and never
 * read it.
 */
export async function requestAccess(input: unknown): Promise<ActionResult> {
  const parsed = Request.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' }
  }

  const supabase = await supabaseServer()
  const { error } = await supabase.from('access_requests').insert({
    email: parsed.data.email,
    note: parsed.data.note || null,
  })

  if (error) {
    // The partial unique index on pending requests. Saying "already asked" is
    // friendlier than a constraint name, and it is not a leak: the person
    // submitting already knows their own address.
    if (error.code === '23505') {
      return { ok: false, error: 'You have already asked. Brian will be in touch.' }
    }
    return { ok: false, error: error.message }
  }

  return { ok: true, data: undefined }
}

const Resolve = z.object({ id: z.uuid() })

export async function approveAccessRequest(input: unknown): Promise<ActionResult> {
  const parsed = Resolve.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid request' }

  const supabase = await supabaseServer()
  // security definer, and it checks household membership itself.
  const { error } = await supabase.rpc('approve_access_request', {
    request_id: parsed.data.id,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/settings/access')
  return { ok: true, data: undefined }
}

export async function declineAccessRequest(input: unknown): Promise<ActionResult> {
  const parsed = Resolve.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid request' }

  const supabase = await supabaseServer()
  const { error } = await supabase.rpc('decline_access_request', {
    request_id: parsed.data.id,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/settings/access')
  return { ok: true, data: undefined }
}
