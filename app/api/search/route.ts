import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { supabaseServer } from '@/lib/db/server'
import type { SearchHit } from '@/lib/types'

const Query = z.object({
  q: z.string().trim().max(200),
  limit: z.coerce.number().int().min(1).max(50).default(12),
})

type Row = {
  item_id: string
  name: string
  quantity: number
  category: string | null
  rank: number
  zone_id: string | null
  zone_name: string | null
  shelf_name: string | null
  container_id: string | null
  container_label: string | null
}

export async function GET(request: NextRequest) {
  const parsed = Query.safeParse({
    q: request.nextUrl.searchParams.get('q') ?? '',
    limit: request.nextUrl.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Bad query' }, { status: 400 })
  }
  if (!parsed.data.q) return NextResponse.json({ hits: [] })

  const supabase = await supabaseServer()
  // RLS scopes this to the caller's household; no household filter needed here.
  const { data, error } = await supabase.rpc('search_items', {
    q: parsed.data.q,
    lim: parsed.data.limit,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const hits: SearchHit[] = (data as Row[]).map((r) => ({
    item_id: r.item_id,
    name: r.name,
    quantity: r.quantity,
    category: r.category,
    rank: r.rank,
    location: r.container_id && r.zone_id
      ? {
        zone_id: r.zone_id,
        zone_name: r.zone_name ?? '',
        shelf_name: r.shelf_name ?? '',
        container_id: r.container_id,
        container_label: r.container_label ?? '',
      }
      : null,
  }))

  return NextResponse.json({ hits })
}
