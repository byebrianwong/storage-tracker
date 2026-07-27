'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

type Props = {
  floorId: string
  /** Drives the copy: the first upload is the empty state, later ones replace. */
  hasPlan: boolean
}

const ACCEPT = '.png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf'

/** Matches MAX_UPLOAD_BYTES in the route, so the obvious case fails instantly. */
const MAX_BYTES = 25 * 1024 * 1024

/**
 * Section 5.1 and 9.1's empty state.
 *
 * A plain fetch to the route handler rather than a Server Action, because the
 * PDF rasterizer has to stay on the Node runtime behind an explicit endpoint.
 * The route revalidates /setup/plan itself; the refresh here is what pulls the
 * new signed URL into this render.
 */
export function PlanUpload({ floorId, hasPlan }: Props) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File) {
    if (file.size > MAX_BYTES) {
      setError('That file is over the 25 MB limit')
      return
    }
    setBusy(true)
    setError(null)

    const body = new FormData()
    body.set('file', file)
    body.set('floorId', floorId)

    try {
      const response = await fetch('/api/plan/upload', { method: 'POST', body })
      const result = (await response.json()) as
        | { ok: true; data: { width: number; height: number } }
        | { ok: false; error: string }
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
    } catch {
      setError('The upload did not go through. Check your connection and try again.')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className={hasPlan ? 'flex flex-wrap items-center gap-3' : 'surface p-8 text-center'}>
      {!hasPlan && (
        <>
          <h2 className="zonename mb-1">Upload your floor plan</h2>
          <p className="muted mb-4 text-sm">
            A PNG, JPG or PDF. Page 1 of a PDF is rendered for you.
          </p>
        </>
      )}

      <label className="btn primary cursor-pointer">
        {busy ? 'Working' : hasPlan ? 'Replace plan' : 'Choose a file'}
        <input
          ref={input}
          type="file"
          className="sr-only"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void upload(file)
          }}
        />
      </label>

      {hasPlan && (
        <p className="mono muted text-[10px]">PNG, JPG or PDF, up to 25 MB.</p>
      )}

      {busy && (
        <p className="mono muted mt-2 text-[10px]" role="status">
          Uploading and measuring the plan. A large PDF takes a few seconds.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--err)' }}>{error}</p>
      )}
    </div>
  )
}
