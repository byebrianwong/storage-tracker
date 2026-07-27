'use client'

import Link from 'next/link'
import { SearchBox } from '@/components/search/SearchBox'

type Props = {
  sync: { state: 'ok' | 'pending' | 'error'; queued: number; conflicts: number }
}

/** Section 9.1: search pinned at the top, sync chip that links to the log. */
export function AppBar({ sync }: Props) {
  const label =
    sync.state === 'error' ? (sync.conflicts > 0 ? `${sync.conflicts} conflicts` : 'Sync error')
      : sync.state === 'pending' ? `${sync.queued} queued`
        : 'Notion in sync'

  return (
    <header
      className="sticky top-0 z-30 flex flex-wrap items-center gap-3 px-4 py-3"
      style={{ background: 'var(--bar-bg)', borderBottom: 'var(--rule)' }}
    >
      <Link href="/plan" className="brand shrink-0 no-underline">Where is it</Link>

      <div className="order-3 min-w-0 flex-1 basis-full sm:order-2 sm:basis-64">
        <SearchBox />
      </div>

      <Link
        href="/settings/sync"
        className="mono muted order-2 ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] no-underline sm:order-3"
      >
        <span className="dot" data-state={sync.state} aria-hidden="true" />
        {label}
      </Link>
    </header>
  )
}
