'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ElevationCanvas } from '@/components/elevation/ElevationCanvas'
import { ContainerPanel, type PanelItem } from '@/components/items/ContainerPanel'
import { supabaseBrowser } from '@/lib/db/browser'
import { DB_SCHEMA } from '@/lib/db/constants'
import type { ZoneWithLayout } from '@/lib/types'

type Props = {
  zone: ZoneWithLayout
  containers: { id: string; label: string; shelfName: string }[]
  initialSelectedId: string | null
  initialItems: PanelItem[]
}

export function ZoneView({ zone, containers, initialSelectedId, initialItems }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)
  const [items, setItems] = useState<PanelItem[]>(initialItems)
  const [loading, setLoading] = useState(false)

  // Plain derivation, not useMemo: the compiler memoizes this better than the
  // hand written version, which it had to skip.
  const selected = zone.shelves
    .flatMap((shelf) => shelf.containers.map((c) => ({ container: c, shelfName: shelf.name })))
    .find((entry) => entry.container.id === selectedId) ?? null

  const loadItems = useCallback(async (containerId: string) => {
    setLoading(true)
    const { data } = await supabaseBrowser()
      .from('items')
      .select('id, name, quantity')
      .eq('container_id', containerId)
      .is('deleted_at', null)
      .order('created_at')
    setItems((data ?? []) as PanelItem[])
    setLoading(false)
  }, [])

  function select(containerId: string) {
    setSelectedId(containerId)
    void loadItems(containerId)
    // Keep the URL shareable and back-button friendly.
    const next = new URLSearchParams(search.toString())
    next.set('container', containerId)
    router.replace(`${pathname}?${next}`, { scroll: false })
  }

  function close() {
    setSelectedId(null)
    setItems([])
    const next = new URLSearchParams(search.toString())
    next.delete('container')
    router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false })
  }

  // Section 2: Realtime on items and containers, so a Notion sync write shows up
  // without the user refreshing.
  useEffect(() => {
    const supabase = supabaseBrowser()
    const channel = supabase
      .channel(`zone-${zone.id}`)
      .on('postgres_changes', { event: '*', schema: DB_SCHEMA, table: 'items' }, () => {
        if (selectedId) void loadItems(selectedId)
        router.refresh()
      })
      .on('postgres_changes', { event: '*', schema: DB_SCHEMA, table: 'containers' }, () => {
        router.refresh()
      })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [zone.id, selectedId, loadItems, router])

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <ElevationCanvas
          zone={zone}
          selectedContainerId={selectedId}
          onSelect={select}
        />
      </div>

      {/* Section 9.2: bottom sheet on mobile, right rail on desktop. */}
      {selected && (
        <div className="fixed inset-x-0 bottom-0 z-40 max-h-[70dvh] overflow-auto p-3 lg:static lg:z-auto lg:max-h-none lg:p-0">
          <ContainerPanel
            key={selected.container.id}
            containerId={selected.container.id}
            containerLabel={selected.container.label}
            zoneName={zone.name}
            shelfName={selected.shelfName}
            items={loading ? [] : items}
            moveTargets={containers.filter((c) => c.id !== selected.container.id)}
            onClose={close}
          />
        </div>
      )}
    </div>
  )
}
