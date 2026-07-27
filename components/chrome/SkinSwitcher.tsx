'use client'

import { useTransition } from 'react'
import { setSkin } from '@/app/actions/appearance'
import { SKINS, type SkinId } from '@/lib/theme/tags'

/**
 * Section 9.5 said switching visual direction should cost nothing. All three
 * ship as token sets, so it costs one cookie.
 */
export function SkinSwitcher({ current }: { current: SkinId }) {
  const [pending, start] = useTransition()

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Visual direction">
      <span className="eyebrow">Look</span>
      {SKINS.map((skin) => (
        <button
          key={skin.id}
          className="btn"
          style={{
            minHeight: 32,
            padding: '4px 10px',
            fontSize: 12,
            ...(skin.id === current
              ? { background: 'var(--accent)', borderColor: 'var(--accent-line)', color: 'var(--on-accent)' }
              : {}),
          }}
          aria-pressed={skin.id === current}
          title={skin.blurb}
          disabled={pending}
          onClick={() => start(() => setSkin(skin.id).then(() => undefined))}
        >
          {skin.name}
        </button>
      ))}
    </div>
  )
}
