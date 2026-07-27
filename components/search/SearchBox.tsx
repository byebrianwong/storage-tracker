'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SearchHit } from '@/lib/types'

/**
 * Sections 8 and 9.1. Cmd/Ctrl+K from anywhere. Every result shows the full
 * location path and deep links into the elevation with the container selected.
 */
export function SearchBox() {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // Derived, not stored: when the box is empty we simply do not render the last
  // results, rather than clearing state from inside an effect.
  const term = q.trim()
  const visible = term ? hits : []

  useEffect(() => {
    if (!term) return

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        })
        if (!res.ok) return
        const json = (await res.json()) as { hits: SearchHit[] }
        setHits(json.hits)
        setActive(0)
        setOpen(true)
      } catch {
        // aborted or offline; the box just shows nothing new
      }
    }, 120)

    return () => { controller.abort(); clearTimeout(timer) }
  }, [term])

  function go(hit: SearchHit) {
    setOpen(false)
    if (!hit.location) { router.push('/search?q=' + encodeURIComponent(q)); return }
    router.push(`/zone/${hit.location.zone_id}?container=${hit.location.container_id}`)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || visible.length === 0) {
      if (e.key === 'Enter' && q.trim()) router.push('/search?q=' + encodeURIComponent(q))
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % visible.length) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + visible.length) % visible.length) }
    if (e.key === 'Enter') { e.preventDefault(); go(visible[active]) }
  }

  return (
    <div ref={box} className="relative">
      <label htmlFor="search" className="sr-only">Find an item</label>
      <input
        id="search"
        ref={input}
        className="field"
        style={{ fontSize: 13, padding: '8px 12px' }}
        type="search"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => visible.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Find an item, try “sleeping bag”"
        role="combobox"
        aria-expanded={open}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-activedescendant={open && visible[active] ? `hit-${visible[active].item_id}` : undefined}
      />

      {open && (
        <div
          id="search-results"
          role="listbox"
          className="surface absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-72 overflow-auto"
          style={{ boxShadow: 'var(--shadow)' }}
        >
          {visible.length === 0 && (
            <p className="muted p-3 text-sm">No match. Try a category like camping or docs.</p>
          )}
          {visible.map((hit, i) => (
            <button
              key={hit.item_id}
              id={`hit-${hit.item_id}`}
              role="option"
              aria-selected={i === active}
              className="rule block w-full border-0 p-2.5 text-left text-sm last:border-b-0"
              style={{ background: i === active ? 'var(--hover)' : 'transparent' }}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(hit)}
            >
              {hit.name}
              <span className="mono muted mt-0.5 block text-[11px]">
                {hit.location
                  ? `${hit.location.zone_name} / ${hit.location.shelf_name} / ${hit.location.container_label}`
                  : 'Unsorted'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
