'use client'

import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabaseBrowser } from '@/lib/db/browser'

function LoginForm() {
  const params = useSearchParams()
  const next = params.get('next') ?? '/plan'
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setState('sending')
    const supabase = supabaseBrowser()
    const redirect = new URL('/auth/confirm', window.location.origin)
    redirect.searchParams.set('next', next)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirect.toString() },
    })
    if (error) {
      setState('error')
      setMessage(error.message)
    } else {
      setState('sent')
    }
  }

  if (state === 'sent') {
    return (
      <div className="surface p-6">
        <h1 className="brand mb-3">Check your email</h1>
        <p className="text-sm leading-relaxed">
          We sent a sign in link to <span className="mono">{email}</span>. Open it on this
          device and you will land back here.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={send} className="surface p-6">
      <h1 className="brand mb-1">Where is it</h1>
      <p className="muted mb-5 text-sm">Sign in with a magic link. No password.</p>

      <label htmlFor="email" className="eyebrow mb-2 block">Email</label>
      <input
        id="email"
        className="field mb-4"
        type="email"
        required
        autoComplete="email"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />

      <button className="btn primary w-full" type="submit" disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Send magic link'}
      </button>

      {state === 'error' && (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--err)' }}>{message}</p>
      )}
    </form>
  )
}

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm items-center px-4">
      <div className="w-full">
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  )
}
