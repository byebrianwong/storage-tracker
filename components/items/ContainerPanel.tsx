'use client'

import { useState, useTransition } from 'react'
import { deleteItem, moveContents } from '@/app/actions/items'
import { AddItemForm } from './AddItemForm'
import type { Item } from '@/lib/types'

export type PanelItem = Pick<Item, 'id' | 'name' | 'quantity'> & { pending?: boolean }

type Props = {
  containerId: string
  containerLabel: string
  zoneName: string
  shelfName: string
  items: PanelItem[]
  /** Every other container in this zone, for the move destination list. */
  moveTargets: { id: string; label: string; shelfName: string }[]
  notionUrl?: string | null
  onClose?: () => void
}

/**
 * Section 9.2. Bottom sheet on mobile, right rail on desktop, same component.
 */
export function ContainerPanel({
  containerId, containerLabel, zoneName, shelfName,
  items: initial, moveTargets, notionUrl, onClose,
}: Props) {
  const [items, setItems] = useState<PanelItem[]>(initial)
  const [moveOpen, setMoveOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [, start] = useTransition()

  // Re-sync when the server sends new data, for instance after a Realtime event
  // from the Notion pull worker. Adjusting state during render is React's own
  // recommended pattern for this; an effect would cause a cascading re-render.
  const [lastServerItems, setLastServerItems] = useState(initial)
  if (initial !== lastServerItems) {
    setLastServerItems(initial)
    setItems(initial)
  }

  function optimisticAdd(name: string) {
    const tempId = `temp-${Math.random().toString(36).slice(2)}`
    setItems((prev) => [...prev, { id: tempId, name, quantity: 1, pending: true }])
    return tempId
  }

  function settleAdd(tempId: string, realId: string | null, error?: string) {
    setItems((prev) => realId
      ? prev.map((i) => (i.id === tempId ? { ...i, id: realId, pending: false } : i))
      // Section 9.3: server rejected it, roll back and show the reason inline.
      : prev.filter((i) => i.id !== tempId))
    if (error) setNotice(error)
  }

  function remove(id: string) {
    const snapshot = items
    setItems((prev) => prev.filter((i) => i.id !== id))
    start(async () => {
      const res = await deleteItem({ id })
      if (!res.ok) {
        setItems(snapshot)
        setNotice(res.error)
      }
    })
  }

  function doMove(to: string) {
    setMoveOpen(false)
    const snapshot = items
    setItems([])
    start(async () => {
      const res = await moveContents({ from: containerId, to })
      if (!res.ok) {
        setItems(snapshot)
        setNotice(res.error)
      } else {
        setNotice(`Moved ${res.data.moved} ${res.data.moved === 1 ? 'item' : 'items'}.`)
      }
    })
  }

  return (
    <aside
      className="surface p-4"
      aria-label={`Contents of ${containerLabel}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="zonename truncate">{containerLabel}</h2>
          <p className="mono muted mt-0.5 text-xs">
            {zoneName} / {shelfName}
          </p>
        </div>
        {onClose && (
          <button className="btn shrink-0 px-3" onClick={onClose} aria-label="Close panel">✕</button>
        )}
      </div>

      <ul className="mt-3 list-none p-0">
        {items.map((item) => (
          <li
            key={item.id}
            className="rule flex items-center justify-between gap-3 py-2 last:border-b-0"
            style={{ opacity: item.pending ? 0.55 : 1 }}
          >
            <span className="min-w-0 truncate text-sm">{item.name}</span>
            <span className="flex shrink-0 items-center gap-3">
              <span className="mono muted text-xs">{item.quantity}</span>
              <button
                className="muted text-xs underline underline-offset-2"
                onClick={() => remove(item.id)}
                disabled={item.pending}
                aria-label={`Remove ${item.name}`}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
        {items.length === 0 && (
          <li className="muted py-2 text-sm">Nothing logged here yet. Add the first item.</li>
        )}
      </ul>

      <AddItemForm
        containerId={containerId}
        onOptimistic={optimisticAdd}
        onSettled={settleAdd}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn" onClick={() => setMoveOpen((v) => !v)} aria-expanded={moveOpen}>
          Move contents
        </button>
        {notionUrl && (
          <a className="btn" href={notionUrl} target="_blank" rel="noreferrer noopener">
            Open in Notion
          </a>
        )}
      </div>

      {moveOpen && (
        <div className="surface mt-2 p-2">
          <p className="eyebrow mb-2">Move everything to</p>
          {moveTargets.length === 0 && (
            <p className="muted text-sm">No other container in this zone yet.</p>
          )}
          <ul className="list-none p-0">
            {moveTargets.map((t) => (
              <li key={t.id}>
                <button
                  className="w-full py-2 text-left text-sm"
                  onClick={() => doMove(t.id)}
                >
                  {t.label}
                  <span className="mono muted ml-2 text-xs">{t.shelfName}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {notice && (
        <p role="status" className="muted mt-2 text-sm">{notice}</p>
      )}
    </aside>
  )
}
