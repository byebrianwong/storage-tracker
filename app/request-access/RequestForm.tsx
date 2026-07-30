'use client'

import { useState, useTransition } from 'react'
import { requestAccess } from '@/app/actions/access'

export function RequestForm({ defaultEmail }: { defaultEmail: string | null }) {
  const [email, setEmail] = useState(defaultEmail ?? '')
  const [note, setNote] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  if (sent) {
    return (
      <p role="status" className="text-sm leading-relaxed">
        Thanks — that is logged. If Brian adds you, sign in with{' '}
        <span className="mono">{email}</span> and you are in.
      </p>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        start(async () => {
          const res = await requestAccess({ email, note })
          if (res.ok) setSent(true)
          else setError(res.error)
        })
      }}
    >
      <label htmlFor="email" className="eyebrow mb-2 block">Email</label>
      <input
        id="email"
        className="field mb-3"
        type="email"
        required
        autoComplete="email"
        readOnly={Boolean(defaultEmail)}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />

      <label htmlFor="note" className="eyebrow mb-2 block">
        Anything to add <span className="muted">(optional)</span>
      </label>
      <textarea
        id="note"
        className="field mb-4"
        rows={3}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What would you use it for?"
      />

      <button className="btn primary w-full" type="submit" disabled={pending || !email.trim()}>
        {pending ? 'Sending…' : 'Request access'}
      </button>

      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--err)' }}>{error}</p>
      )}
    </form>
  )
}
