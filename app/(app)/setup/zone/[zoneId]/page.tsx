import Link from 'next/link'
import { notFound } from 'next/navigation'
import { zoneWithLayout } from '@/lib/queries'
import { ContainerEditor } from './ContainerEditor'

export default async function ZoneSetupPage({
  params,
}: { params: Promise<{ zoneId: string }> }) {
  const { zoneId } = await params
  const zone = await zoneWithLayout(zoneId)
  if (!zone) notFound()

  return (
    <>
      <nav className="mono muted mb-3 text-[11px]" aria-label="Breadcrumb">
        <Link href="/plan" className="no-underline" style={{ color: 'var(--muted)' }}>Home</Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/zone/${zone.id}`} className="no-underline" style={{ color: 'var(--muted)' }}>
          {zone.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span style={{ color: 'var(--ink)' }}>Edit shelves</span>
      </nav>

      <div className="mb-3">
        <p className="eyebrow">Shelf and container editor</p>
        <h1 className="zonename">{zone.name}</h1>
      </div>

      <ContainerEditor zone={zone} />
    </>
  )
}
