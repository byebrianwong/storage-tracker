'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { runFullReconcile } from '@/app/actions/notion'

/** Section 7.8: the manual full reconcile. Section 7.6 owns what it actually does. */
export function ReconcileButton({ disabled }: { disabled: boolean }) {
  const router = useRouter()
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, start] = useTransition()

  function run() {
    setNotice(null)
    setError(null)
    start(async () => {
      const res = await runFullReconcile()
      if (res.ok) {
        setNotice(res.data.note)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button className="btn" onClick={run} disabled={busy || disabled}>
        {busy ? 'Reconciling…' : 'Run full reconcile'}
      </button>
      {notice && <span role="status" className="muted text-sm">{notice}</span>}
      {error && <span role="alert" className="text-sm" style={{ color: 'var(--err)' }}>{error}</span>}
    </div>
  )
}
