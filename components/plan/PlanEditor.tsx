'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react'
import {
  boundingBox,
  centroid,
  clampPoint,
  expandForTouch,
  polygonArea,
  rectPolygon,
  toNormalized,
  toPixels,
} from '@/lib/geometry'
import type { Point, Polygon } from '@/lib/types'
import { createZone, deleteZone, updateZoneMeta, updateZonePolygon } from '@/app/actions/zones'

/* -------------------------------------------------------------------------- */
/* Pure editor math. Exported so lib/geometry/planEditor.test.ts can cover it   */
/* without a DOM. Nothing below this block reimplements lib/geometry.           */
/* -------------------------------------------------------------------------- */

/** Section 9.4's minimum touch target, and so the vertex grab radius. */
export const TOUCH_MIN_PX = 44

/** How near the pointer has to be to a corner to grab it instead of the body. */
export const VERTEX_GRAB_PX = TOUCH_MIN_PX / 2

/** Arrow key step, and the shifted step, in normalized units. */
export const NUDGE = 0.004
export const NUDGE_COARSE = 0.02

/**
 * Below this the drag was a click, not a rectangle. In normalized units, so on
 * a 1200 px wide plan it is a 6 px flick.
 */
export const MIN_RECT_SIDE = 0.005

/** A closed polygon flatter than this is a crease, not a storage area. */
const MIN_AREA = 1e-6

/**
 * Index of the corner nearest `p`, or null if the nearest one is further than
 * `maxPx` away on screen.
 *
 * The comparison happens in pixels, not normalized units, because the plan is
 * drawn with a non-uniform viewBox: 0.01 along x and 0.01 along y are different
 * distances under the user's finger, and a normalized radius would make corners
 * on a wide plan much easier to grab than tall ones.
 */
export function nearestVertex(
  poly: Polygon,
  p: Point,
  maxPx: number,
  width: number,
  height: number,
): number | null {
  const target = toPixels(p, width, height)
  let best: number | null = null
  let bestDistance = maxPx
  for (let i = 0; i < poly.length; i++) {
    const v = toPixels(poly[i], width, height)
    const distance = Math.hypot(v[0] - target[0], v[1] - target[1])
    if (distance <= bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/**
 * A rectangle from a press and a release, or null when the gesture was too
 * small to have been meant as one.
 *
 * `rectPolygon` already clamps and sorts the corners, so every drag direction
 * lands on the same four points; all this adds is the "that was a click"
 * threshold, which is what stops a stray tap from creating a zero size zone.
 */
export function rectFromDrag(a: Point, b: Point, minSide: number = MIN_RECT_SIDE): Polygon | null {
  const poly = rectPolygon(a, b)
  const bb = boundingBox(poly)
  if (bb.w < minSide || bb.h < minSide) return null
  return poly
}

/**
 * Translate the whole polygon, clamped so its bounding box stays on the plan.
 *
 * Clamping each point on its own would deform the shape the moment one corner
 * reached an edge, which is exactly when a drag is hardest to control. The
 * delta is clamped instead, so the polygon slides until it touches and stops
 * rigid.
 */
export function translatePolygon(poly: Polygon, dx: number, dy: number): Polygon {
  if (poly.length === 0) return []
  const bb = boundingBox(poly)
  const clampDelta = (d: number, min: number, extent: number) => {
    const lo = -min
    const hi = 1 - min - extent
    // A polygon wider than the plan has no legal position; refuse to move it
    // rather than snapping it to an arbitrary edge.
    if (hi < lo) return 0
    if (!Number.isFinite(d)) return 0
    return Math.min(Math.max(d, lo), hi)
  }
  const ddx = clampDelta(dx, bb.x, bb.w)
  const ddy = clampDelta(dy, bb.y, bb.h)
  return poly.map((p): Point => [p[0] + ddx, p[1] + ddy])
}

/** One corner moved, clamped into 0..1. Out of range indexes are a no-op. */
export function replaceVertex(poly: Polygon, index: number, p: Point): Polygon {
  if (index < 0 || index >= poly.length) return poly
  const moved = clampPoint(p)
  return poly.map((v, i): Point => (i === index ? moved : v))
}

/**
 * A click-by-click draft turned into a storable polygon, or null if it is not
 * one yet.
 *
 * Consecutive duplicates are dropped because closing on a double click fires a
 * single click first, which has already placed a point exactly where the
 * closing one lands. The area check catches the other degenerate case: three
 * or more points that are all collinear.
 */
export function closeDraft(draft: Polygon): Polygon | null {
  const points: Polygon = []
  for (const p of draft) {
    const last = points[points.length - 1]
    if (last && last[0] === p[0] && last[1] === p[1]) continue
    points.push([p[0], p[1]])
  }
  // The first and last point meeting is the same duplicate, one lap around.
  const first = points[0]
  const last = points[points.length - 1]
  if (points.length > 3 && first && last && first[0] === last[0] && first[1] === last[1]) {
    points.pop()
  }
  if (points.length < 3) return null
  if (Math.abs(polygonArea(points)) < MIN_AREA) return null
  return points
}

/* -------------------------------------------------------------------------- */
/* Component                                                                    */
/* -------------------------------------------------------------------------- */

export type EditorZone = {
  id: string
  name: string
  code: string | null
  roomLabel: string | null
  polygon: Polygon
}

type Props = {
  floorId: string
  planUrl: string
  planWidth: number
  planHeight: number
  zones: EditorZone[]
}

type Mode = 'rect' | 'polygon'

type Drag = {
  zoneId: string
  kind: 'vertex' | 'body'
  index: number
  grab: Point
  origin: Polygon
}

/** The inline form's subject: a shape with no row yet, or an existing zone. */
type Editing =
  | { kind: 'new'; polygon: Polygon }
  | { kind: 'existing'; zone: EditorZone }

const points = (poly: Polygon) => poly.map(([x, y]) => `${x},${y}`).join(' ')

/**
 * Release a pointer capture only if this element holds it.
 *
 * Several elements can be mid-gesture at once (the surface, a zone, a corner
 * handle) and `releasePointerCapture` throws NotFoundError when the element is
 * not the capturing one, which would abort the rest of the handler and leave
 * the drag stuck.
 */
function releaseCapture(target: Element, pointerId: number) {
  if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
}

/** Zone id to the geometry the server last confirmed it holds. */
const acknowledged = (list: EditorZone[]) =>
  new Map(list.map((z): [string, Polygon] => [z.id, z.polygon]))

/**
 * Section 5.3, the zone editor.
 *
 * Coordinates work exactly as they do in PlanCanvas: the SVG is
 * `viewBox="0 0 1 1"` with `preserveAspectRatio="none"`, so every polygon point
 * is drawn in raw normalized units and there is no pixel conversion to get
 * wrong. Only two things convert, and both go through lib/geometry: pointer
 * positions coming in, and the corner grab radius going out.
 *
 * Anything that has to look circular or hold text (corner handles, zone names)
 * is HTML positioned in percentages rather than SVG, because the non-uniform
 * viewBox would squash a circle into an ellipse and a glyph along with it. That
 * also makes the handles real buttons, which is how they end up in the tab
 * order with a native focus ring.
 */
export function PlanEditor({ floorId, planUrl, planWidth, planHeight, zones }: Props) {
  const ratio = planWidth > 0 && planHeight > 0 ? planWidth / planHeight : 4 / 3
  // Pixel size the grab radius is measured against. Falls back to something
  // plausible so a floor row missing its dimensions still behaves.
  const px = { w: planWidth || 1200, h: planHeight || 900 }

  const surface = useRef<HTMLDivElement>(null)
  const hintId = useId()

  const [mode, setMode] = useState<Mode>('rect')
  const [local, setLocal] = useState<EditorZone[]>(zones)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [draft, setDraft] = useState<Polygon>([])
  const [hover, setHover] = useState<Point | null>(null)
  const [rect, setRect] = useState<{ start: Point; current: Point } | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  /** Last geometry the server acknowledged, for rolling a failed save back. */
  const [acked, setAcked] = useState<ReadonlyMap<string, Polygon>>(() => acknowledged(zones))

  // The server list is the truth, but copying it in on every render would
  // clobber a drag in flight, so it is copied only when the server's own
  // geometry changed. Adjusted during render rather than in an effect: an
  // effect would paint the stale list first and then correct it.
  const signature = useMemo(() => JSON.stringify(zones), [zones])
  const [syncedTo, setSyncedTo] = useState(signature)
  if (signature !== syncedTo) {
    setSyncedTo(signature)
    setLocal(zones)
    setAcked(acknowledged(zones))
  }

  const decorated = useMemo(
    () =>
      local.map((z) => ({
        ...z,
        label: centroid(z.polygon),
        // Section 5.2: thin shapes are unforgiving on a phone, so the tap
        // target is a fattened copy of the outline.
        hit: expandForTouch(z.polygon, TOUCH_MIN_PX, px.w, px.h),
      })),
    [local, px.w, px.h],
  )

  const selected = local.find((z) => z.id === selectedId) ?? null

  /** Client pixels to normalized plan coordinates, clamped onto the plan. */
  const toNorm = useCallback((e: { clientX: number; clientY: number }): Point => {
    const box = surface.current?.getBoundingClientRect()
    if (!box) return [0, 0]
    return clampPoint(toNormalized([e.clientX - box.left, e.clientY - box.top], box.width, box.height))
  }, [])

  const setPolygon = useCallback((zoneId: string, polygon: Polygon) => {
    setLocal((current) => current.map((z) => (z.id === zoneId ? { ...z, polygon } : z)))
  }, [])

  const commit = useCallback((zoneId: string, polygon: Polygon) => {
    // Captured before the write, so a rejection restores the last shape the
    // server actually holds rather than whatever the drag left on screen.
    const previous = acked.get(zoneId)
    startSaving(async () => {
      const result = await updateZonePolygon({ id: zoneId, polygon })
      if (result.ok) {
        setAcked((current) => new Map(current).set(zoneId, polygon))
        setError(null)
        return
      }
      setError(result.error)
      if (previous) setPolygon(zoneId, previous)
    })
  }, [acked, setPolygon])

  // Keyboard nudges arrive one keydown at a time; saving each would be a write
  // per repeat. Coalesce, then commit once the user stops.
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitSoon = useCallback((zoneId: string, polygon: Polygon) => {
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current)
    nudgeTimer.current = setTimeout(() => commit(zoneId, polygon), 500)
  }, [commit])
  useEffect(() => () => {
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current)
  }, [])

  const cancelDrawing = useCallback(() => {
    setDraft([])
    setRect(null)
    setHover(null)
  }, [])

  const finishDraft = useCallback(() => {
    const polygon = closeDraft(draft)
    cancelDrawing()
    if (!polygon) {
      setError('That shape needs at least three corners')
      return
    }
    setError(null)
    setEditing({ kind: 'new', polygon })
  }, [draft, cancelDrawing])

  /* -------------------- global keys: Enter, Escape, Backspace -------------- */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (typing) return

      if (e.key === 'Escape') {
        if (draft.length > 0 || rect) {
          e.preventDefault()
          cancelDrawing()
        } else if (editing) {
          setEditing(null)
        } else if (selectedId) {
          setSelectedId(null)
        }
        return
      }
      if (draft.length === 0) return
      if (e.key === 'Enter') {
        e.preventDefault()
        finishDraft()
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        setDraft((d) => d.slice(0, -1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft.length, rect, editing, selectedId, cancelDrawing, finishDraft])

  /* -------------------------------- drawing ------------------------------- */

  const drawingLocked = editing !== null

  function onSurfacePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (drawingLocked || mode !== 'rect') return
    e.preventDefault()
    setSelectedId(null)
    const p = toNorm(e)
    setRect({ start: p, current: p })
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onSurfacePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (rect) setRect({ ...rect, current: toNorm(e) })
    else if (draft.length > 0) setHover(toNorm(e))
  }

  function onSurfacePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!rect) return
    releaseCapture(e.currentTarget, e.pointerId)
    const polygon = rectFromDrag(rect.start, toNorm(e))
    setRect(null)
    if (polygon) {
      setError(null)
      setEditing({ kind: 'new', polygon })
    }
  }

  function onSurfaceClick(e: React.MouseEvent<HTMLDivElement>) {
    if (drawingLocked || mode !== 'polygon') return
    // A double click fires click(detail 1) then click(detail 2). The first has
    // already placed the closing point, which closeDraft dedupes.
    if (e.detail >= 2) {
      finishDraft()
      return
    }
    setSelectedId(null)
    setDraft((d) => [...d, toNorm(e)])
  }

  /* ------------------------------- zone drags ----------------------------- */

  function beginDrag(zone: EditorZone, e: React.PointerEvent<SVGGElement>) {
    const p = toNorm(e)
    // Section 5.3: the whole polygon only moves with a modifier held, so that
    // on touch, where there is no modifier, a drag is always a corner drag.
    const wantsBody = e.altKey || e.metaKey
    const corner = wantsBody ? null : nearestVertex(zone.polygon, p, VERTEX_GRAB_PX, px.w, px.h)
    if (corner === null && !wantsBody) return

    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({
      zoneId: zone.id,
      kind: corner === null ? 'body' : 'vertex',
      index: corner ?? -1,
      grab: p,
      origin: zone.polygon,
    })
  }

  /** Applies a live drag. `origin` is the geometry at grab time, so no drift. */
  const applyDrag = useCallback((active: Drag, p: Point) => {
    const dx = p[0] - active.grab[0]
    const dy = p[1] - active.grab[1]
    if (active.kind === 'body') {
      setPolygon(active.zoneId, translatePolygon(active.origin, dx, dy))
      return
    }
    const from = active.origin[active.index]
    if (!from) return
    setPolygon(active.zoneId, replaceVertex(active.origin, active.index, [from[0] + dx, from[1] + dy]))
  }, [setPolygon])

  const endDrag = useCallback(() => {
    if (!drag) return
    const zone = local.find((z) => z.id === drag.zoneId)
    setDrag(null)
    if (zone) commit(zone.id, zone.polygon)
  }, [drag, local, commit])

  function nudge(zone: EditorZone, index: number, dx: number, dy: number) {
    const from = zone.polygon[index]
    if (!from) return
    const next = replaceVertex(zone.polygon, index, [from[0] + dx, from[1] + dy])
    setPolygon(zone.id, next)
    commitSoon(zone.id, next)
  }

  /* -------------------------------- saving -------------------------------- */

  function saveEditing(form: { name: string; roomLabel: string; code: string }) {
    if (!editing) return
    const subject = editing
    setError(null)
    startSaving(async () => {
      const result =
        subject.kind === 'new'
          ? await createZone({
            floorId,
            name: form.name,
            roomLabel: form.roomLabel || null,
            code: form.code || null,
            polygon: subject.polygon,
          })
          : await updateZoneMeta({
            id: subject.zone.id,
            name: form.name,
            roomLabel: form.roomLabel || null,
            code: form.code || null,
          })

      if (!result.ok) {
        setError(result.error)
        return
      }
      if (subject.kind === 'new') {
        const id = (result.data as { id: string }).id
        const zone: EditorZone = {
          id,
          name: form.name,
          roomLabel: form.roomLabel || null,
          code: form.code || null,
          polygon: subject.polygon,
        }
        setAcked((current) => new Map(current).set(id, subject.polygon))
        setLocal((current) => [...current, zone])
        setSelectedId(id)
      } else {
        setLocal((current) =>
          current.map((z) =>
            z.id === subject.zone.id
              ? { ...z, name: form.name, roomLabel: form.roomLabel || null, code: form.code || null }
              : z,
          ),
        )
      }
      setEditing(null)
    })
  }

  function removeZone(zone: EditorZone) {
    const confirmed = window.confirm(
      `Delete ${zone.name}? Its shelves, containers and the items in them go too.`,
    )
    if (!confirmed) return
    setError(null)
    startSaving(async () => {
      const result = await deleteZone({ id: zone.id })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setAcked((current) => {
        const next = new Map(current)
        next.delete(zone.id)
        return next
      })
      setLocal((current) => current.filter((z) => z.id !== zone.id))
      setSelectedId(null)
      setEditing(null)
    })
  }

  /* -------------------------------- render -------------------------------- */

  const preview = rect ? rectPolygon(rect.start, rect.current) : null
  const band = draft.length > 0 && hover ? hover : null

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label="Drawing mode">
          {(['rect', 'polygon'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className="btn"
              aria-pressed={mode === m}
              style={
                mode === m
                  ? { background: 'var(--accent)', borderColor: 'var(--accent-line)', color: 'var(--on-accent)' }
                  : undefined
              }
              onClick={() => {
                setMode(m)
                cancelDrawing()
              }}
            >
              {m === 'rect' ? 'Rectangle' : 'Polygon'}
            </button>
          ))}
        </div>

        {draft.length > 0 && (
          <>
            <button type="button" className="btn" onClick={finishDraft} disabled={draft.length < 3}>
              Close shape
            </button>
            <button type="button" className="btn" onClick={cancelDrawing}>Cancel</button>
          </>
        )}

        <p id={hintId} className="mono muted ml-auto text-[10px] leading-tight">
          {mode === 'rect'
            ? 'Drag on the plan to draw a rectangle.'
            : 'Click to place corners. Double click or Enter closes, Escape cancels.'}
          {' Drag a corner to reshape. Hold Alt and drag to move a whole zone.'}
        </p>
      </div>

      <div
        ref={surface}
        className="relative w-full select-none"
        style={{ aspectRatio: String(ratio), touchAction: 'none', cursor: drawingLocked ? 'default' : 'crosshair' }}
        onPointerDown={onSurfacePointerDown}
        onPointerMove={onSurfacePointerMove}
        onPointerUp={onSurfacePointerUp}
        onPointerCancel={() => setRect(null)}
        onClick={onSurfaceClick}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, 1h expiry, not a static asset */}
        <img
          src={planUrl}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-fill"
          draggable={false}
        />

        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          role="group"
          aria-label="Storage areas, editable"
          aria-describedby={hintId}
        >
          {decorated.map((z) => {
            const isSelected = z.id === selectedId
            return (
              <g
                key={z.id}
                className="zone"
                data-selected={isSelected}
                tabIndex={0}
                role="button"
                aria-label={`${z.name}${z.code ? `, ${z.code}` : ''}, ${z.polygon.length} corners`}
                aria-pressed={isSelected}
                style={{ pointerEvents: draft.length > 0 || rect ? 'none' : 'auto' }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  setSelectedId(z.id)
                  beginDrag(z, e)
                }}
                onPointerMove={(e) => {
                  if (drag?.zoneId === z.id) applyDrag(drag, toNorm(e))
                }}
                onPointerUp={(e) => {
                  if (drag?.zoneId !== z.id) return
                  releaseCapture(e.currentTarget, e.pointerId)
                  endDrag()
                }}
                onPointerCancel={endDrag}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedId(z.id)
                  } else if (e.key === 'Delete') {
                    e.preventDefault()
                    removeZone(z)
                  }
                }}
              >
                <polygon points={points(z.polygon)} />
                <polygon className="hitarea" points={points(z.hit)} />
              </g>
            )
          })}

          {/* Draft polygon: the placed edges plus a rubber band to the cursor. */}
          {draft.length > 0 && (
            <polyline
              points={points(band ? [...draft, band] : draft)}
              style={{
                fill: 'none',
                stroke: 'var(--accent-line)',
                strokeWidth: 1.6,
                strokeDasharray: '4 3',
                vectorEffect: 'non-scaling-stroke',
              }}
            />
          )}

          {preview && (
            <polygon
              points={points(preview)}
              style={{
                fill: 'var(--accent)',
                fillOpacity: 0.35,
                stroke: 'var(--accent-line)',
                strokeWidth: 1.6,
                strokeDasharray: '4 3',
                vectorEffect: 'non-scaling-stroke',
              }}
            />
          )}
        </svg>

        {/* HTML overlay: labels and corner handles, undistorted by the viewBox. */}
        <div className="pointer-events-none absolute inset-0">
          {decorated.map((z) => (
            <span
              key={z.id}
              className="zonelabel absolute whitespace-nowrap text-[11px] leading-none"
              style={{
                left: `${z.label[0] * 100}%`,
                top: `${z.label[1] * 100}%`,
                transform: 'translate(-50%, -50%)',
                color: 'var(--ink)',
                fontWeight: z.id === selectedId ? 600 : 400,
              }}
              aria-hidden="true"
            >
              {z.name}
            </span>
          ))}

          {draft.map((p, i) => (
            <span
              key={`draft-${i}`}
              className="absolute block rounded-full"
              style={{
                left: `${p[0] * 100}%`,
                top: `${p[1] * 100}%`,
                width: 9,
                height: 9,
                marginLeft: -4.5,
                marginTop: -4.5,
                background: 'var(--accent-line)',
              }}
              aria-hidden="true"
            />
          ))}

          {/* Only the selected zone gets handles, so 44 px targets on adjacent
              zones never overlap and steal each other's drags. */}
          {selected?.polygon.map((p, i) => (
            <button
              key={`${selected.id}-${i}`}
              type="button"
              className="pointer-events-auto absolute grid place-items-center rounded-full"
              style={{
                left: `${p[0] * 100}%`,
                top: `${p[1] * 100}%`,
                width: TOUCH_MIN_PX,
                height: TOUCH_MIN_PX,
                marginLeft: -TOUCH_MIN_PX / 2,
                marginTop: -TOUCH_MIN_PX / 2,
                background: 'transparent',
                border: 0,
                padding: 0,
                cursor: 'move',
                touchAction: 'none',
              }}
              aria-label={`${selected.name}, corner ${i + 1} of ${selected.polygon.length}. Arrow keys move it.`}
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.currentTarget.setPointerCapture(e.pointerId)
                setDrag({
                  zoneId: selected.id,
                  kind: 'vertex',
                  index: i,
                  grab: toNorm(e),
                  origin: selected.polygon,
                })
              }}
              onPointerMove={(e) => {
                if (drag?.zoneId === selected.id && drag.index === i) applyDrag(drag, toNorm(e))
              }}
              onPointerUp={(e) => {
                if (drag?.zoneId !== selected.id || drag.index !== i) return
                releaseCapture(e.currentTarget, e.pointerId)
                endDrag()
              }}
              onPointerCancel={endDrag}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                const step = e.shiftKey ? NUDGE_COARSE : NUDGE
                const by: Record<string, Point> = {
                  ArrowLeft: [-step, 0],
                  ArrowRight: [step, 0],
                  ArrowUp: [0, -step],
                  ArrowDown: [0, step],
                }
                const delta = by[e.key]
                if (!delta) return
                e.preventDefault()
                e.stopPropagation()
                nudge(selected, i, delta[0], delta[1])
              }}
            >
              <span
                aria-hidden="true"
                className="block rounded-full"
                style={{
                  width: 11,
                  height: 11,
                  background: 'var(--field-bg)',
                  border: '2px solid var(--accent-line)',
                }}
              />
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--err)' }}>{error}</p>
      )}

      {/* Section 5.3: the form is inline, never a separate page. */}
      {editing && (
        <ZoneForm
          key={editing.kind === 'new' ? 'new' : editing.zone.id}
          subject={editing}
          saving={saving}
          onSave={saveEditing}
          onCancel={() => setEditing(null)}
        />
      )}

      {!editing && selected && (
        <div className="surface mt-3 flex flex-wrap items-center gap-2 p-3">
          <p className="eyebrow">Selected</p>
          <p className="zonename mr-auto text-[15px]">{selected.name}</p>
          <button
            type="button"
            className="btn"
            onClick={() => setEditing({ kind: 'existing', zone: selected })}
          >
            Rename
          </button>
          <button
            type="button"
            className="btn"
            style={{ color: 'var(--err)' }}
            onClick={() => removeZone(selected)}
            disabled={saving}
          >
            Delete zone
          </button>
        </div>
      )}

      <p className="mono muted mt-3 text-[10px]">
        {local.length} {local.length === 1 ? 'zone' : 'zones'} drawn
        {saving ? ', saving' : ''}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

type FormProps = {
  subject: Editing
  saving: boolean
  onSave: (values: { name: string; roomLabel: string; code: string }) => void
  onCancel: () => void
}

/**
 * Section 5.3: name, room label and short code in one inline form, shown the
 * moment a shape closes. A new zone does not exist until this is saved, so
 * cancelling throws the shape away rather than leaving an unnamed row.
 */
function ZoneForm({ subject, saving, onSave, onCancel }: FormProps) {
  const zone = subject.kind === 'existing' ? subject.zone : null
  const [name, setName] = useState(zone?.name ?? '')
  const [roomLabel, setRoomLabel] = useState(zone?.roomLabel ?? '')
  const [code, setCode] = useState(zone?.code ?? '')
  const ids = useId()

  return (
    <form
      className="surface mt-3 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        onSave({ name: name.trim(), roomLabel: roomLabel.trim(), code: code.trim() })
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <p className="eyebrow mb-2">{zone ? 'Edit zone' : 'New zone'}</p>

      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
        <div>
          <label className="eyebrow" htmlFor={`${ids}-name`}>Name</label>
          <input
            id={`${ids}-name`}
            className="field mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Entry closet"
            autoFocus
            autoComplete="off"
            required
          />
        </div>
        <div>
          <label className="eyebrow" htmlFor={`${ids}-room`}>Room</label>
          <input
            id={`${ids}-room`}
            className="field mt-1"
            value={roomLabel}
            onChange={(e) => setRoomLabel(e.target.value)}
            placeholder="Entry"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="eyebrow" htmlFor={`${ids}-code`}>Code</label>
          <input
            id={`${ids}-code`}
            className="field mt-1 mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="A1"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <button type="submit" className="btn primary" disabled={saving || !name.trim()}>
          {zone ? 'Save' : 'Add zone'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}
