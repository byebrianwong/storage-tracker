'use client'

import type { CSSProperties } from 'react'
import { layoutElevation } from '@/lib/elevation/layout'
import { tagColor } from '@/lib/theme/tags'
import type { ZoneWithLayout } from '@/lib/types'

type Props = {
  zone: ZoneWithLayout
  selectedContainerId?: string | null
  /** Container ids matched by the current search, drawn with the hot outline. */
  highlightedIds?: ReadonlySet<string>
  onSelect?: (containerId: string) => void
}

/**
 * Section 6. A dumb mapping from layoutElevation() to SVG. All arithmetic lives
 * in the layout function; all colour lives in CSS custom properties.
 */
export function ElevationCanvas({
  zone, selectedContainerId, highlightedIds, onSelect,
}: Props) {
  const layout = layoutElevation(zone)

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="block h-auto w-full"
      role="img"
      aria-label={`Straight on view of ${zone.name}`}
    >
      <defs>
        {/* Direction A fills a full container with drafting hatch. */}
        <pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="var(--case-fill)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--hair)" strokeWidth="1" />
        </pattern>
      </defs>

      <rect
        className="frame"
        x={layout.frame.x} y={layout.frame.y}
        width={layout.frame.w} height={layout.frame.h}
      />

      {layout.shelves.map((shelf) => (
        <g key={shelf.id}>
          <text className="shelflabel" x={layout.frame.x + 8} y={shelf.labelY}>
            {shelf.name}
          </text>
          <line
            className="board"
            x1={layout.frame.x} y1={shelf.boardY}
            x2={layout.frame.x + layout.frame.w} y2={shelf.boardY}
          />

          {shelf.containers.map((c) => {
            const selected = c.id === selectedContainerId
            const hit = highlightedIds?.has(c.id) ?? false
            return (
              <g
                key={c.id}
                className="box"
                data-selected={selected}
                data-hit={hit}
                style={{ '--tag-color': tagColor(c.colorTag) } as CSSProperties}
                tabIndex={0}
                role="button"
                aria-label={`${c.label}, ${c.itemCount} ${c.itemCount === 1 ? 'item' : 'items'}, on ${shelf.name}`}
                aria-pressed={selected}
                onClick={() => onSelect?.(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect?.(c.id)
                  }
                }}
              >
                <rect className="body" x={c.x} y={c.y} width={c.w} height={c.h} />
                <rect
                  className="plate"
                  x={c.x + c.w / 2 - 52} y={c.y + c.h / 2 - 26}
                  width={104} height={34} rx={2}
                />
                <text
                  className="boxtitle"
                  x={c.x + c.w / 2} y={c.y + c.h / 2 - 3}
                  textAnchor="middle"
                >
                  {c.label}
                </text>
                <text
                  className="boxmeta"
                  x={c.x + c.w / 2} y={c.y + c.h / 2 + 14}
                  textAnchor="middle"
                >
                  {c.itemCount} {c.itemCount === 1 ? 'item' : 'items'}
                </text>
                <circle className="knob" cx={c.x + c.w / 2} cy={c.y + c.h - 18} r={5} />
              </g>
            )
          })}
        </g>
      ))}

      {/* Height dimension, direction A only, hidden by --dim-display elsewhere. */}
      {layout.shelves.length > 0 && (
        <g>
          <line className="dim" x1={layout.dimension.x} y1={layout.dimension.y1}
                x2={layout.dimension.x} y2={layout.dimension.y2} />
          <line className="dim" x1={layout.dimension.x - 5} y1={layout.dimension.y1}
                x2={layout.dimension.x + 5} y2={layout.dimension.y1} />
          <line className="dim" x1={layout.dimension.x - 5} y1={layout.dimension.y2}
                x2={layout.dimension.x + 5} y2={layout.dimension.y2} />
          <text className="dimtext" x={layout.dimension.x} y={layout.dimension.y1 - 10}
                textAnchor="middle">
            {layout.dimension.label}
          </text>
        </g>
      )}
    </svg>
  )
}
