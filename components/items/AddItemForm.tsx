'use client'

import { useRef, useState, useTransition } from 'react'
import { addItem } from '@/app/actions/items'

type Props = {
  containerId: string
  /** Optimistic insert. Return the temp id so it can be reconciled or rolled back. */
  onOptimistic: (name: string) => string
  onSettled: (tempId: string, realId: string | null, error?: string) => void
}

/**
 * Section 9.3. One text field with autofocus. Enter saves and KEEPS focus,
 * because items get added in batches standing in front of a closet.
 * Category and tags are collapsed behind More.
 */
export function AddItemForm({ containerId, onOptimistic, onSettled }: Props) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [tags, setTags] = useState('')
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const input = useRef<HTMLInputElement>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return

    const tempId = onOptimistic(trimmed)
    setName('')
    setError(null)
    // Keep the caret where the next item is going to be typed.
    input.current?.focus()

    start(async () => {
      const result = await addItem({
        containerId,
        name: trimmed,
        category: category.trim() || null,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      })
      if (result.ok) {
        onSettled(tempId, result.data.id)
      } else {
        onSettled(tempId, null, result.error)
        setError(result.error)
      }
    })
  }

  return (
    <form onSubmit={submit} className="mt-3">
      <label htmlFor="add-item" className="sr-only">Add an item</label>
      <div className="flex gap-2">
        <input
          id="add-item"
          ref={input}
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add an item"
          autoFocus
          autoComplete="off"
          enterKeyHint="done"
        />
        <button className="btn primary shrink-0" type="submit" disabled={pending || !name.trim()}>
          Add
        </button>
      </div>

      <button
        type="button"
        className="eyebrow mt-2 underline underline-offset-2"
        onClick={() => setMore((v) => !v)}
        aria-expanded={more}
      >
        {more ? 'Less' : 'More'}
      </button>

      {more && (
        <div className="mt-2 grid gap-2">
          <input
            className="field" value={category} onChange={(e) => setCategory(e.target.value)}
            placeholder="Category, for example Camping" aria-label="Category"
          />
          <input
            className="field" value={tags} onChange={(e) => setTags(e.target.value)}
            placeholder="Tags, comma separated" aria-label="Tags"
          />
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--err)' }}>{error}</p>
      )}
    </form>
  )
}
