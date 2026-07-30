'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { approveAccessRequest, declineAccessRequest } from '@/app/actions/access'

type Props = {
  request: { id: string; email: string; note: string | null; created_at: string }
}

export function RequestRow({ request }: Props) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function act(fn: typeof approveAccessRequest) {
    setError(null)
    start(async () => {
      const res = await fn({ id: request.id })
      if (!res.ok) setError(res.error)
      else router.refresh()
    })
  }

  return (
    <div className="surface mb-2 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mono truncate text-sm">{request.email}</p>
          <p className="muted mt-0.5 text-[11px]">
            {new Date(request.created_at).toLocaleDateString()}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className="btn primary"
            style={{ minHeight: 36, fontSize: 12 }}
            disabled={pending}
            onClick={() => act(approveAccessRequest)}
          >
            Approve
          </button>
          <button
            className="btn"
            style={{ minHeight: 36, fontSize: 12 }}
            disabled={pending}
            onClick={() => act(declineAccessRequest)}
          >
            Decline
          </button>
        </div>
      </div>

      {request.note && (
        <p className="mt-2 text-sm leading-relaxed">{request.note}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--err)' }}>{error}</p>
      )}
    </div>
  )
}
