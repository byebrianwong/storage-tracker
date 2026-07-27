'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

const Skin = z.enum(['a', 'b', 'c'])

/**
 * Section 9.5. The whole visual direction is one attribute on <html>, read from
 * this cookie server side so there is no flash of the wrong skin.
 */
export async function setSkin(value: unknown) {
  const parsed = Skin.safeParse(value)
  if (!parsed.success) return

  const store = await cookies()
  store.set('skin', parsed.data, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
  revalidatePath('/', 'layout')
}
