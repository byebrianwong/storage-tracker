import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentHousehold } from '@/lib/db/server'
import { currentFloor, planSignedUrl, zonesForPlan, unsortedCount } from '@/lib/queries'
import { PlanView } from './PlanView'

export default async function PlanPage() {
  const householdId = await currentHousehold()
  if (!householdId) redirect('/login')

  const floor = await currentFloor(householdId)
  if (!floor) {
    return (
      <div className="surface p-8 text-center">
        <p className="muted mb-4 text-sm">No home set up yet.</p>
        <Link className="btn primary" href="/setup/plan">Upload your floor plan</Link>
      </div>
    )
  }

  const [planUrl, zones, unsorted] = await Promise.all([
    planSignedUrl(floor.plan_path as string | null),
    zonesForPlan(floor.id as string),
    unsortedCount(householdId),
  ])

  const totalItems = zones.reduce((n, z) => n + z.itemCount, 0)

  return (
    <>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Floor plan</p>
          <h1 className="zonename">{(floor.name as string) ?? 'Main floor'}</h1>
        </div>
        <Link className="mono muted text-[11px] no-underline" href="/setup/plan">
          Edit zones
        </Link>
      </div>

      {/* Section 7.5: rows that arrived from Notion with no Location. */}
      {unsorted.count > 0 && unsorted.zoneId && (
        <Link
          href={`/zone/${unsorted.zoneId}?container=${unsorted.containerId}`}
          className="surface mb-3 flex items-center gap-2 px-3 py-2 text-sm no-underline"
          style={{ color: 'var(--ink)', borderColor: 'var(--warn)' }}
        >
          <span className="dot" data-state="pending" aria-hidden="true" />
          Unsorted, {unsorted.count} {unsorted.count === 1 ? 'item' : 'items'} from Notion with no location
        </Link>
      )}

      <PlanView
        planUrl={planUrl}
        planWidth={(floor.plan_width as number) ?? 0}
        planHeight={(floor.plan_height as number) ?? 0}
        zones={zones}
      />

      <p className="mono muted mt-3 text-[10px]">
        {zones.length} storage {zones.length === 1 ? 'area' : 'areas'}, {totalItems} items logged
      </p>
    </>
  )
}
