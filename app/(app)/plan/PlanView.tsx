'use client'

import { useRouter } from 'next/navigation'
import { PlanCanvas, type PlanZone } from '@/components/plan/PlanCanvas'

type Props = {
  planUrl: string | null
  planWidth: number
  planHeight: number
  zones: PlanZone[]
}

/** Section 9.1: tapping a zone navigates to the elevation view. */
export function PlanView({ planUrl, planWidth, planHeight, zones }: Props) {
  const router = useRouter()
  return (
    <PlanCanvas
      planUrl={planUrl}
      planWidth={planWidth}
      planHeight={planHeight}
      zones={zones}
      onSelect={(zoneId) => router.push(`/zone/${zoneId}`)}
    />
  )
}
