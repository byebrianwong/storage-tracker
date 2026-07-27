import 'server-only'
import { NextResponse } from 'next/server'
import { supabaseService } from '@/lib/db/service'
import { supabaseSyncStore } from './store'
import { liveNotionApi } from '@/lib/notion/api'
import { isNotionConfigured } from '@/lib/notion/client'

/**
 * Shared setup for every /api/sync/* route: authenticate the caller against
 * CRON_SECRET, then resolve the household's Notion configuration.
 */
export function authorizeCron(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  const header = request.headers.get('authorization')
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export type SyncContext = {
  store: ReturnType<typeof supabaseSyncStore>
  api: ReturnType<typeof liveNotionApi>
  householdId: string
  itemsDataSourceId: string
  locationsDataSourceId: string
}

export async function syncContexts(): Promise<SyncContext[]> {
  if (!isNotionConfigured()) return []

  const db = supabaseService()
  const { data } = await db
    .from('notion_config')
    .select('household_id, items_data_source_id, locations_data_source_id')
    .not('items_data_source_id', 'is', null)

  const store = supabaseSyncStore(db)
  const api = liveNotionApi()

  return (data ?? []).map((row) => ({
    store,
    api,
    householdId: row.household_id as string,
    itemsDataSourceId: row.items_data_source_id as string,
    locationsDataSourceId: (row.locations_data_source_id as string | null) ?? '',
  }))
}
