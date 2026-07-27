'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { resolveConflict } from '@/app/actions/notion'

export type ConflictView = {
  id: string
  itemName: string
  createdAt: string
  createdLabel: string
  appValue: Record<string, unknown> | null
  notionValue: Record<string, unknown> | null
}

/** The fields section 7.3 syncs two way, in the order the handoff lists them. */
const FIELDS: { key: string; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'location_page_id', label: 'Location' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'category', label: 'Category' },
  { key: 'tags', label: 'Tags' },
  { key: 'notes', label: 'Notes' },
  { key: 'archived', label: 'Archived' },
]

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ')
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Section 7.8: one unresolved conflict, both values visible, two buttons.
 *
 * Every field is shown rather than only the differing ones, because "the field
 * I care about is identical on both sides" is exactly the reassurance you want
 * before clicking a button that overwrites the other side.
 */
export function ConflictCard({ conflict }: { conflict: ConflictView }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState<'app' | 'notion' | null>(null)
  const [busy, start] = useTransition()

  function resolve(resolution: 'app' | 'notion') {
    setError(null)
    start(async () => {
      const res = await resolveConflict({ conflictId: conflict.id, resolution })
      if (res.ok) {
        setResolved(resolution)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  if (resolved) {
    return (
      <li className="surface p-3">
        <p className="muted text-sm" role="status">
          Kept the {resolved === 'app' ? 'app' : 'Notion'} value for {conflict.itemName}.
        </p>
      </li>
    )
  }

  return (
    <li className="surface p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="zonename">{conflict.itemName}</span>
        <time className="mono muted text-[11px]" dateTime={conflict.createdAt}>
          {conflict.createdLabel}
        </time>
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            App and Notion values for {conflict.itemName}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="eyebrow rule py-1 text-left">Field</th>
              <th scope="col" className="eyebrow rule py-1 text-left">In the app</th>
              <th scope="col" className="eyebrow rule py-1 text-left">In Notion</th>
            </tr>
          </thead>
          <tbody>
            {FIELDS.map(({ key, label }) => {
              const app = conflict.appValue?.[key]
              const notion = conflict.notionValue?.[key]
              const differs = display(app) !== display(notion)
              return (
                <tr key={key} style={differs ? undefined : { opacity: 0.55 }}>
                  <th scope="row" className="mono rule py-1 pr-3 text-left font-normal align-top">
                    {label}
                  </th>
                  <td
                    className="rule py-1 pr-3 align-top"
                    style={differs ? { color: 'var(--ink)', fontWeight: 600 } : undefined}
                  >
                    {display(app)}
                  </td>
                  <td
                    className="rule py-1 align-top"
                    style={differs ? { color: 'var(--ink)', fontWeight: 600 } : undefined}
                  >
                    {display(notion)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn" onClick={() => resolve('app')} disabled={busy}>
          Keep app value
        </button>
        <button className="btn" onClick={() => resolve('notion')} disabled={busy}>
          Keep Notion value
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--err)' }}>{error}</p>
      )}
    </li>
  )
}
