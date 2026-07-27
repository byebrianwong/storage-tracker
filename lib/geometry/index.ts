/**
 * Polygon math for the floor plan. Section 5.2.
 *
 * Every point that crosses this boundary is NORMALIZED: x and y both in 0..1,
 * relative to the plan image, so re-exporting the plan at a different
 * resolution never invalidates stored geometry. Pixels exist only at render
 * time, which is why the two functions that reason about pixels take the plan's
 * rendered width and height explicitly instead of reading them from anywhere.
 *
 * Everything here is pure and side effect free.
 */
import type { Point, Polygon } from '@/lib/types'

/** A normalized length at or below this is treated as zero. */
const EPS = 1e-12

/** Tolerance for "this point sits on that edge", in normalized units. */
const ON_EDGE_EPS = 1e-9

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** Normalized point to pixels for the given rendered plan size. */
export function toPixels(p: Point, width: number, height: number): Point {
  return [p[0] * width, p[1] * height]
}

/**
 * Pixels back to normalized for the given rendered plan size.
 *
 * A zero dimension yields 0 rather than NaN or Infinity: layout runs before
 * images measure, and a NaN coordinate poisons every polygon downstream.
 */
export function toNormalized(p: Point, width: number, height: number): Point {
  return [width === 0 ? 0 : p[0] / width, height === 0 ? 0 : p[1] / height]
}

/** Clamp both axes into 0..1. Non finite input collapses to 0. */
export function clampPoint(p: Point): Point {
  return [clamp01(p[0]), clamp01(p[1])]
}

/**
 * Signed area in normalized units, by the shoelace formula.
 *
 * Positive means the polygon is wound the same way as `rectPolygon` output.
 * Fewer than three points has no area, so it returns 0.
 */
export function polygonArea(poly: Polygon): number {
  const n = poly.length
  if (n < 3) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    sum += p[0] * q[1] - q[0] * p[1]
  }
  return sum / 2
}

function meanPoint(poly: Polygon): Point {
  const n = poly.length
  if (n === 0) return [0, 0]
  let sx = 0
  let sy = 0
  for (const p of poly) {
    sx += p[0]
    sy += p[1]
  }
  return [sx / n, sy / n]
}

/**
 * Area weighted polygon centroid, for label placement.
 *
 * Degenerate polygons (fewer than three points, all points identical, all
 * points collinear) have zero area and would divide by zero, so they fall back
 * to the arithmetic mean of the vertices. This never returns NaN.
 */
export function centroid(poly: Polygon): Point {
  const n = poly.length
  if (n === 0) return [0, 0]
  const area = polygonArea(poly)
  if (n < 3 || Math.abs(area) < EPS) return meanPoint(poly)

  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    const cross = p[0] * q[1] - q[0] * p[1]
    cx += (p[0] + q[0]) * cross
    cy += (p[1] + q[1]) * cross
  }
  const k = 6 * area
  const out: Point = [cx / k, cy / k]
  // Belt and braces: any float pathology falls back rather than emitting NaN.
  return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : meanPoint(poly)
}

/** True when p lies on segment ab, including either endpoint. */
function isOnSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
  if (Math.abs(cross) > ON_EDGE_EPS) return false
  return (
    p[0] >= Math.min(a[0], b[0]) - ON_EDGE_EPS &&
    p[0] <= Math.max(a[0], b[0]) + ON_EDGE_EPS &&
    p[1] >= Math.min(a[1], b[1]) - ON_EDGE_EPS &&
    p[1] <= Math.max(a[1], b[1]) + ON_EDGE_EPS
  )
}

/**
 * Ray casting hit test, correct for concave polygons and either winding.
 *
 * A point exactly on an edge or on a vertex counts as inside. Ray casting is
 * otherwise undefined on the boundary, and on a phone the boundary is where
 * half the taps land.
 */
export function pointInPolygon(p: Point, poly: Polygon): boolean {
  const n = poly.length
  if (n === 0) return false
  const x = p[0]
  const y = p[1]
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false

  for (let i = 0; i < n; i++) {
    if (isOnSegment(p, poly[i], poly[(i + 1) % n])) return true
  }
  if (n < 3) return false

  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside
    }
  }
  return inside
}

/** Axis aligned bounds in normalized units. An empty polygon is all zeros. */
export function boundingBox(poly: Polygon): { x: number; y: number; w: number; h: number } {
  if (poly.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * A hit polygon at least `minPx` across in both dimensions, for the plan
 * rendered at `width` by `height` pixels. Result is still normalized.
 *
 * Thin shapes (a rod, a narrow closet) are unforgiving as SVG hit areas on
 * touch, so the shape is scaled outward about its centroid until its bounding
 * box clears the 44 px minimum. Polygons already big enough come back
 * unchanged: this only ever grows, never shrinks.
 *
 * The result is deliberately NOT clamped to 0..1. Clamping a shape at the edge
 * of the plan would flatten it back below the minimum and break the guarantee,
 * and a hit polygon is never stored, only tested against.
 */
export function expandForTouch(poly: Polygon, minPx: number, width: number, height: number): Polygon {
  const copy: Polygon = poly.map((p): Point => [p[0], p[1]])
  if (copy.length === 0) return copy
  if (!(minPx > 0) || !(width > 0) || !(height > 0)) return copy

  // The required extent expressed in normalized units, one per axis.
  const needX = minPx / width
  const needY = minPx / height
  const bb = boundingBox(copy)
  if (bb.w >= needX && bb.h >= needY) return copy

  if (bb.w < EPS || bb.h < EPS) {
    // No extent on an axis means there is nothing to scale outward: a scale
    // factor times zero is still zero. Cover the shape with the smallest
    // acceptable rectangle instead, keeping the original inside it.
    const w = Math.max(bb.w, needX)
    const h = Math.max(bb.h, needY)
    const midX = bb.x + bb.w / 2
    const midY = bb.y + bb.h / 2
    return [
      [midX - w / 2, midY - h / 2],
      [midX + w / 2, midY - h / 2],
      [midX + w / 2, midY + h / 2],
      [midX - w / 2, midY + h / 2],
    ]
  }

  const sx = Math.max(1, needX / bb.w)
  const sy = Math.max(1, needY / bb.h)
  const c = centroid(copy)
  return copy.map((p): Point => [c[0] + (p[0] - c[0]) * sx, c[1] + (p[1] - c[1]) * sy])
}

/**
 * A four point rectangle from two opposite corners, for the zone editor's
 * rectangle mode. Section 5.3.
 *
 * Corners are clamped into 0..1 and sorted, so all four drag directions produce
 * the identical polygon: top left first, then clockwise on screen, which is the
 * positive signed area winding.
 */
export function rectPolygon(a: Point, b: Point): Polygon {
  const p = clampPoint(a)
  const q = clampPoint(b)
  const x0 = Math.min(p[0], q[0])
  const x1 = Math.max(p[0], q[0])
  const y0 = Math.min(p[1], q[1])
  const y1 = Math.max(p[1], q[1])
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
}
