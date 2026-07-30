import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentHouseholdId, supabaseServer } from '@/lib/db/server'
import { currentFloor, planSignedUrl } from '@/lib/queries'
import { PolygonSchema } from '@/lib/types'
import { PlanEditor, type EditorZone } from '@/components/plan/PlanEditor'
import { PlanUpload } from './PlanUpload'

/** The plan is a signed URL with a one hour expiry, so never prerender this. */
export const dynamic = 'force-dynamic'

/**
 * Zones as the editor needs them.
 *
 * `zonesForPlan` is shaped for the plan view: it counts items and drops
 * `room_label`, both of which are wrong here. The editor wants the raw fields
 * of the inline form and nothing else. RLS scopes the read to the household.
 */
async function editorZones(floorId: string): Promise<EditorZone[]> {
  const supabase = await supabaseServer()
  const { data, error } = await supabase
    .from('zones')
    .select('id, name, code, room_label, polygon')
    .eq('floor_id', floorId)
    .order('sort_order')

  if (error) throw error

  return (data ?? []).flatMap((z) => {
    const parsed = PolygonSchema.safeParse(z.polygon)
    // A malformed polygon is not editable and would poison every drag, so it is
    // left out rather than guessed at. The row itself is untouched.
    if (!parsed.success) return []
    return [{
      id: z.id as string,
      name: z.name as string,
      code: (z.code as string | null) ?? null,
      roomLabel: (z.room_label as string | null) ?? null,
      polygon: parsed.data,
    }]
  })
}

/** Section 5.1 and 5.3: upload the plan, then draw zones on it. */
export default async function SetupPlanPage() {
  const householdId = await currentHouseholdId()
  if (!householdId) redirect('/login')

  const floor = await currentFloor(householdId)
  if (!floor) {
    return (
      <div className="surface p-8 text-center">
        <p className="muted text-sm">No home set up yet. Sign out and back in to bootstrap one.</p>
      </div>
    )
  }

  const floorId = floor.id as string
  const planUrl = await planSignedUrl(floor.plan_path as string | null)
  const zones = planUrl ? await editorZones(floorId) : []

  return (
    <>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Setup</p>
          <h1 className="zonename">{(floor.name as string) ?? 'Main floor'}</h1>
        </div>
        <Link className="mono muted text-[11px] no-underline" href="/plan">
          Back to the plan
        </Link>
      </div>

      <div className={planUrl ? 'mb-3' : ''}>
        <PlanUpload floorId={floorId} hasPlan={planUrl !== null} />
      </div>

      {planUrl && (
        <PlanEditor
          floorId={floorId}
          planUrl={planUrl}
          planWidth={(floor.plan_width as number | null) ?? 0}
          planHeight={(floor.plan_height as number | null) ?? 0}
          zones={zones}
        />
      )}

      <p className="mono muted mt-4 text-[10px]">
        Zones are stored as normalized coordinates, so re-uploading the plan at a different
        resolution keeps every shape where it is.
      </p>
    </>
  )
}
