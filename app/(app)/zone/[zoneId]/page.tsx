import Link from 'next/link'
import { notFound } from 'next/navigation'
import { zoneWithLayout, itemsInContainer } from '@/lib/queries'
import { ZoneView } from './ZoneView'

type Props = {
  params: Promise<{ zoneId: string }>
  searchParams: Promise<{ container?: string }>
}

export default async function ZonePage({ params, searchParams }: Props) {
  const { zoneId } = await params
  const { container } = await searchParams

  const zone = await zoneWithLayout(zoneId)
  if (!zone) notFound()

  const all = zone.shelves.flatMap((s) => s.containers.map((c) => ({ ...c, shelfName: s.name })))
  // Deep link from search, section 8: open with this container already selected.
  const selectedId = container && all.some((c) => c.id === container)
    ? container
    : null

  const items = selectedId ? await itemsInContainer(selectedId) : []

  return (
    <>
      <nav className="mono muted mb-3 text-[11px]" aria-label="Breadcrumb">
        <Link href="/plan" className="no-underline" style={{ color: 'var(--muted)' }}>Home</Link>
        <span aria-hidden="true"> / </span>
        <span style={{ color: 'var(--ink)' }}>{zone.name}</span>
      </nav>

      <div className="mb-3">
        <p className="eyebrow">{zone.room_label ?? 'Storage'} / straight on view</p>
        <h1 className="zonename">{zone.name}</h1>
      </div>

      <ZoneView
        zone={zone}
        containers={all.map((c) => ({ id: c.id, label: c.label, shelfName: c.shelfName }))}
        initialSelectedId={selectedId}
        initialItems={items}
      />
    </>
  )
}
