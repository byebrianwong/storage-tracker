'use client'

import { useMemo, type CSSProperties } from 'react'
import { centroid, expandForTouch, boundingBox } from '@/lib/geometry'
import { tagColor } from '@/lib/theme/tags'
import type { Polygon } from '@/lib/types'

export type PlanZone = {
  id: string
  name: string
  code: string | null
  polygon: Polygon
  labelAnchor: { x: number; y: number; anchor: 'start' | 'middle' | 'end' } | null
  itemCount: number
  colorTag: string | null
}

type Props = {
  planUrl: string | null
  planWidth: number
  planHeight: number
  zones: PlanZone[]
  selectedZoneId?: string | null
  highlightedIds?: ReadonlySet<string>
  onSelect: (zoneId: string) => void
}

/** Below this fraction of the plan's shorter axis, the label goes outside on a leader. */
const LABEL_INSIDE_MIN = 0.09
const TOUCH_MIN_PX = 44

/**
 * Section 5.3 and 9.1.
 *
 * The SVG uses viewBox="0 0 1 1" with preserveAspectRatio="none", so polygon
 * points are drawn in raw normalized units and there is no pixel conversion to
 * get wrong. The wrapper carries the image's true aspect ratio, so nothing looks
 * stretched.
 *
 * Labels are HTML positioned in percentages rather than SVG <text>, because a
 * non-uniform viewBox would squash glyphs. That also makes them real selectable
 * text for a screen reader.
 */
export function PlanCanvas({
  planUrl, planWidth, planHeight, zones,
  selectedZoneId, highlightedIds, onSelect,
}: Props) {
  const ratio = planWidth > 0 && planHeight > 0 ? planWidth / planHeight : 4 / 3

  const decorated = useMemo(() => zones.map((z) => {
    const bb = boundingBox(z.polygon)
    const c = centroid(z.polygon)
    const anchor = z.labelAnchor ?? { x: c[0], y: c[1], anchor: 'middle' as const }
    // Section 9.1: too small to hold its own label, so put it outside.
    const outside = Math.min(bb.w, bb.h) < LABEL_INSIDE_MIN
    /*
      Put the label on whichever side has room, so it never runs off the plan.
      The threshold is generous because the label is HTML and its width depends
      on the zone's name; a short name at 0.8 still clipped in the demo, where
      "Balcony deck box" ends at 0.816.
    */
    const toLeft = outside && bb.x + bb.w > 0.72
    const labelPos = outside
      ? { x: toLeft ? Math.max(0.02, bb.x - 0.02) : Math.min(0.98, bb.x + bb.w + 0.02), y: bb.y + bb.h / 2 }
      : { x: anchor.x, y: anchor.y }
    return {
      ...z,
      centroid: c,
      labelPos,
      outside,
      toLeft,
      /*
        Section 5.2, two layers.

        Geometry first: grow anything degenerate relative to the plan's own
        proportions. This is measured in the plan's intrinsic pixels, so it
        cannot express a real world 44px on its own.

        The real touch slop is the stroke on `.hitarea` in globals.css, which
        uses vector-effect: non-scaling-stroke. That is specified in SCREEN
        pixels no matter how the plan is scaled into the viewport, so it stays
        correct on a 360px phone and a 1440px desktop without measuring
        anything. Measuring would need a ResizeObserver, which is one more
        runtime dependency for something CSS already expresses exactly.
      */
      hit: expandForTouch(z.polygon, TOUCH_MIN_PX, planWidth || 1000, planHeight || 750),
    }
  }), [zones, planWidth, planHeight])

  if (!planUrl) {
    return (
      <div className="surface flex flex-col items-center justify-center gap-3 p-10 text-center">
        <p className="muted text-sm">No floor plan yet.</p>
        <a className="btn primary" href="/setup/plan">Upload your floor plan</a>
      </div>
    )
  }

  return (
    <div className="relative w-full" style={{ aspectRatio: String(ratio) }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, 1h expiry, not a static asset */}
      <img
        src={planUrl}
        alt=""
        className="absolute inset-0 h-full w-full object-fill"
        draggable={false}
      />

      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        role="group"
        aria-label="Storage areas on the floor plan"
      >
        {decorated.map((z) => {
          const selected = z.id === selectedZoneId
          const hit = highlightedIds?.has(z.id) ?? false
          const pts = (p: Polygon) => p.map(([x, y]) => `${x},${y}`).join(' ')
          return (
            <g
              key={z.id}
              className="zone"
              data-selected={selected}
              data-hit={hit}
              style={{ '--tag-color': tagColor(z.colorTag) } as CSSProperties}
              tabIndex={0}
              role="button"
              aria-label={`${z.name}, ${z.itemCount} ${z.itemCount === 1 ? 'item' : 'items'}`}
              aria-pressed={selected}
              onClick={() => onSelect(z.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(z.id)
                }
              }}
            >
              <polygon points={pts(z.polygon)} />
              {z.outside && (
                <line
                  className="leader"
                  x1={z.centroid[0]} y1={z.centroid[1]}
                  x2={z.labelPos.x} y2={z.labelPos.y}
                />
              )}
              {/* Invisible, drawn last so it sits on top and takes the tap. */}
              <polygon className="hitarea" points={pts(z.hit)} />
            </g>
          )
        })}
      </svg>

      {/* Labels live in HTML so they are not distorted by the non-uniform viewBox. */}
      <div className="pointer-events-none absolute inset-0">
        {decorated.map((z) => (
          <span
            key={z.id}
            className="zonelabel absolute whitespace-nowrap text-[11px] leading-none"
            style={{
              left: `${z.labelPos.x * 100}%`,
              top: `${z.labelPos.y * 100}%`,
              // Flip an outside label to the left when it would run off the plan.
              transform: z.outside
                ? (z.toLeft ? 'translate(-100%, -50%)' : 'translate(0, -50%)')
                : 'translate(-50%, -50%)',
              fontWeight: z.id === selectedZoneId ? 600 : 400,
            }}
            aria-hidden="true"
          >
            {/*
              Nine full names cannot fit across a 330px plan without colliding.
              Zones already carry a short drafting code, so show that on narrow
              screens and the full name where there is room. Done with CSS rather
              than a JS breakpoint so there is no hydration mismatch. The
              accessible name on the <g> is always the full one.
            */}
            {z.code && <span className="zonelabel-code mono">{z.code}</span>}
            <span className={z.code ? 'zonelabel-full' : undefined}>
              {z.name}
              <span className="mono muted ml-1 text-[10px]">{z.itemCount}</span>
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
