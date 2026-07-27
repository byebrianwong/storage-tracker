import { describe, it, expect } from 'vitest'
import type { Point, Polygon } from '@/lib/types'
import {
  boundingBox,
  centroid,
  clampPoint,
  expandForTouch,
  pointInPolygon,
  polygonArea,
  rectPolygon,
  toNormalized,
  toPixels,
} from '@/lib/geometry'

/** Unit square, wound the same way rectPolygon winds. */
const SQUARE: Polygon = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

/**
 * An L, normalized. Two 0.5 squares along the bottom plus one on the top left,
 * so the top right quadrant is a notch that is outside the polygon but inside
 * its bounding box.
 */
const L_SHAPE: Polygon = [
  [0, 0],
  [1, 0],
  [1, 0.5],
  [0.5, 0.5],
  [0.5, 1],
  [0, 1],
]

function expectPointClose(actual: Point, expected: Point, digits = 10): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits)
  expect(actual[1]).toBeCloseTo(expected[1], digits)
}

describe('toPixels and toNormalized', () => {
  it('converts a normalized point to pixels for the rendered size', () => {
    expect(toPixels([0.5, 0.25], 800, 600)).toEqual([400, 150])
    expect(toPixels([0, 0], 800, 600)).toEqual([0, 0])
    expect(toPixels([1, 1], 800, 600)).toEqual([800, 600])
  })

  it('converts pixels back to normalized', () => {
    expect(toNormalized([400, 150], 800, 600)).toEqual([0.5, 0.25])
    expect(toNormalized([800, 600], 800, 600)).toEqual([1, 1])
  })

  it('round trips normalized to pixels and back at several plan sizes', () => {
    const points: Point[] = [
      [0, 0],
      [1, 1],
      [0.5, 0.5],
      [0.123456, 0.987654],
      [0.0001, 0.9999],
    ]
    const sizes: [number, number][] = [
      [800, 600],
      [2400, 1350],
      [375, 812],
      [1, 1],
    ]
    for (const [w, h] of sizes) {
      for (const p of points) {
        expectPointClose(toNormalized(toPixels(p, w, h), w, h), p)
      }
    }
  })

  it('round trips pixels to normalized and back', () => {
    const w = 1024
    const h = 768
    for (const px of [
      [0, 0],
      [512, 384],
      [1023, 767],
      [1024, 768],
    ] as Point[]) {
      expectPointClose(toPixels(toNormalized(px, w, h), w, h), px)
    }
  })

  it('yields 0 rather than NaN or Infinity when the plan has not measured yet', () => {
    expect(toNormalized([100, 100], 0, 0)).toEqual([0, 0])
    expect(toNormalized([100, 100], 0, 500)).toEqual([0, 0.2])
    expect(toNormalized([100, 100], 500, 0)).toEqual([0.2, 0])
  })

  it('does not mutate its input', () => {
    const p: Point = [0.25, 0.75]
    toPixels(p, 800, 600)
    toNormalized(p, 800, 600)
    expect(p).toEqual([0.25, 0.75])
  })
})

describe('clampPoint', () => {
  it('leaves in range points alone', () => {
    expect(clampPoint([0, 0])).toEqual([0, 0])
    expect(clampPoint([0.4, 0.6])).toEqual([0.4, 0.6])
    expect(clampPoint([1, 1])).toEqual([1, 1])
  })

  it('clamps both axes into 0..1', () => {
    expect(clampPoint([-3, 0.5])).toEqual([0, 0.5])
    expect(clampPoint([0.5, 42])).toEqual([0.5, 1])
    expect(clampPoint([-0.001, 1.001])).toEqual([0, 1])
  })

  it('collapses non finite input to 0 instead of propagating NaN', () => {
    expect(clampPoint([NaN, 0.5])).toEqual([0, 0.5])
    expect(clampPoint([Infinity, -Infinity])).toEqual([0, 0])
  })
})

describe('polygonArea', () => {
  it('measures the unit square', () => {
    expect(polygonArea(SQUARE)).toBeCloseTo(1, 12)
  })

  it('is signed: reversing the winding flips the sign', () => {
    expect(polygonArea([...SQUARE].reverse())).toBeCloseTo(-1, 12)
  })

  it('measures a triangle and an L', () => {
    expect(
      polygonArea([
        [0, 0],
        [1, 0],
        [0, 1],
      ]),
    ).toBeCloseTo(0.5, 12)
    expect(polygonArea(L_SHAPE)).toBeCloseTo(0.75, 12)
  })

  it('is zero for collinear points and for under three points', () => {
    expect(
      polygonArea([
        [0, 0],
        [0.5, 0.5],
        [1, 1],
      ]),
    ).toBe(0)
    expect(polygonArea([])).toBe(0)
    expect(
      polygonArea([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(0)
  })
})

describe('centroid', () => {
  it('finds the middle of a square', () => {
    expectPointClose(centroid(SQUARE), [0.5, 0.5])
    expectPointClose(centroid(rectPolygon([0.2, 0.4], [0.6, 0.8])), [0.4, 0.6])
  })

  it('is area weighted, not the mean of the vertices', () => {
    // Two 0.5 squares at (0.5, 0.25) and one at (0.25, 0.75):
    // (0.5*0.5 + 0.25*0.25) / 0.75 = 0.41666...
    expectPointClose(centroid(L_SHAPE), [5 / 12, 5 / 12])
    // The plain vertex mean would be 0.5, 0.5. Prove we are not returning that.
    expect(centroid(L_SHAPE)[0]).not.toBeCloseTo(0.5, 3)
  })

  it('is winding independent', () => {
    expectPointClose(centroid([...L_SHAPE].reverse()), [5 / 12, 5 / 12])
  })

  it('falls back to the vertex mean for a zero area polygon, never NaN', () => {
    const collinear: Polygon = [
      [0.2, 0.2],
      [0.4, 0.4],
      [0.6, 0.6],
    ]
    const c = centroid(collinear)
    expectPointClose(c, [0.4, 0.4])
    expect(Number.isNaN(c[0])).toBe(false)
    expect(Number.isNaN(c[1])).toBe(false)
  })

  it('falls back for a polygon collapsed to a single repeated point', () => {
    const c = centroid([
      [0.3, 0.7],
      [0.3, 0.7],
      [0.3, 0.7],
      [0.3, 0.7],
    ])
    expectPointClose(c, [0.3, 0.7])
  })

  it('handles a degenerate horizontal sliver of exactly zero height', () => {
    const c = centroid([
      [0.1, 0.5],
      [0.9, 0.5],
      [0.5, 0.5],
    ])
    expect(Number.isFinite(c[0])).toBe(true)
    expect(c[1]).toBeCloseTo(0.5, 12)
  })

  it('handles under three points and the empty polygon', () => {
    expectPointClose(
      centroid([
        [0.2, 0.2],
        [0.8, 0.6],
      ]),
      [0.5, 0.4],
    )
    expect(centroid([[0.4, 0.9]])).toEqual([0.4, 0.9])
    expect(centroid([])).toEqual([0, 0])
  })

  it('stays inside a convex polygon', () => {
    expect(pointInPolygon(centroid(SQUARE), SQUARE)).toBe(true)
  })
})

describe('pointInPolygon', () => {
  it('accepts interior points and rejects exterior points', () => {
    expect(pointInPolygon([0.5, 0.5], SQUARE)).toBe(true)
    expect(pointInPolygon([0.01, 0.99], SQUARE)).toBe(true)
    expect(pointInPolygon([1.5, 0.5], SQUARE)).toBe(false)
    expect(pointInPolygon([-0.01, 0.5], SQUARE)).toBe(false)
    expect(pointInPolygon([0.5, 2], SQUARE)).toBe(false)
  })

  it('counts a point exactly on an edge as inside', () => {
    const rect = rectPolygon([0.2, 0.2], [0.8, 0.6])
    expect(pointInPolygon([0.5, 0.2], rect)).toBe(true) // top edge
    expect(pointInPolygon([0.5, 0.6], rect)).toBe(true) // bottom edge
    expect(pointInPolygon([0.2, 0.4], rect)).toBe(true) // left edge
    expect(pointInPolygon([0.8, 0.4], rect)).toBe(true) // right edge
  })

  it('counts a point exactly on a vertex as inside', () => {
    const rect = rectPolygon([0.2, 0.2], [0.8, 0.6])
    for (const v of rect) {
      expect(pointInPolygon(v, rect)).toBe(true)
    }
  })

  it('counts a point on a diagonal edge as inside', () => {
    const tri: Polygon = [
      [0, 0],
      [1, 0],
      [0, 1],
    ]
    expect(pointInPolygon([0.5, 0.5], tri)).toBe(true) // hypotenuse
    expect(pointInPolygon([0.51, 0.51], tri)).toBe(false)
    expect(pointInPolygon([0.49, 0.49], tri)).toBe(true)
  })

  it('handles a concave L: the notch is outside even though it is in the bbox', () => {
    expect(pointInPolygon([0.25, 0.25], L_SHAPE)).toBe(true) // bottom left arm
    expect(pointInPolygon([0.75, 0.25], L_SHAPE)).toBe(true) // bottom right arm
    expect(pointInPolygon([0.25, 0.75], L_SHAPE)).toBe(true) // top left arm
    expect(pointInPolygon([0.75, 0.75], L_SHAPE)).toBe(false) // the notch
    expect(pointInPolygon([0.99, 0.99], L_SHAPE)).toBe(false)
  })

  it('counts the L reflex vertex and the notch edges as inside', () => {
    expect(pointInPolygon([0.5, 0.5], L_SHAPE)).toBe(true) // reflex vertex
    expect(pointInPolygon([0.75, 0.5], L_SHAPE)).toBe(true) // edge under the notch
    expect(pointInPolygon([0.5, 0.75], L_SHAPE)).toBe(true) // edge beside the notch
  })

  it('gives the same answers for either winding', () => {
    const cw: Polygon = [...L_SHAPE].reverse()
    for (const p of [
      [0.25, 0.25],
      [0.75, 0.75],
      [0.5, 0.5],
      [0.75, 0.25],
    ] as Point[]) {
      expect(pointInPolygon(p, cw)).toBe(pointInPolygon(p, L_SHAPE))
    }
  })

  it('rejects everything for a degenerate or non finite input', () => {
    expect(pointInPolygon([0.5, 0.5], [])).toBe(false)
    expect(pointInPolygon([NaN, 0.5], SQUARE)).toBe(false)
    // A two point "polygon" is just a segment: only the segment itself hits.
    const seg: Polygon = [
      [0.2, 0.2],
      [0.8, 0.2],
    ]
    expect(pointInPolygon([0.5, 0.2], seg)).toBe(true)
    expect(pointInPolygon([0.5, 0.3], seg)).toBe(false)
  })
})

describe('boundingBox', () => {
  it('bounds a rectangle and an L', () => {
    expect(boundingBox(rectPolygon([0.2, 0.3], [0.7, 0.9]))).toEqual({
      x: 0.2,
      y: 0.3,
      w: 0.7 - 0.2,
      h: 0.9 - 0.3,
    })
    expect(boundingBox(L_SHAPE)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('bounds an unordered polygon', () => {
    const bb = boundingBox([
      [0.6, 0.1],
      [0.2, 0.8],
      [0.9, 0.4],
    ])
    expect(bb.x).toBeCloseTo(0.2, 12)
    expect(bb.y).toBeCloseTo(0.1, 12)
    expect(bb.w).toBeCloseTo(0.7, 12)
    expect(bb.h).toBeCloseTo(0.7, 12)
  })

  it('is zero sized for a collapsed polygon and for no polygon', () => {
    expect(boundingBox([[0.5, 0.5]])).toEqual({ x: 0.5, y: 0.5, w: 0, h: 0 })
    expect(boundingBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('rectPolygon', () => {
  const expected: Polygon = [
    [0.2, 0.3],
    [0.7, 0.3],
    [0.7, 0.8],
    [0.2, 0.8],
  ]

  it('produces the same polygon from all four drag directions', () => {
    expect(rectPolygon([0.2, 0.3], [0.7, 0.8])).toEqual(expected) // down right
    expect(rectPolygon([0.7, 0.8], [0.2, 0.3])).toEqual(expected) // up left
    expect(rectPolygon([0.7, 0.3], [0.2, 0.8])).toEqual(expected) // down left
    expect(rectPolygon([0.2, 0.8], [0.7, 0.3])).toEqual(expected) // up right
  })

  it('winds consistently, whichever way the drag went', () => {
    const areas = [
      polygonArea(rectPolygon([0.2, 0.3], [0.7, 0.8])),
      polygonArea(rectPolygon([0.7, 0.8], [0.2, 0.3])),
      polygonArea(rectPolygon([0.7, 0.3], [0.2, 0.8])),
      polygonArea(rectPolygon([0.2, 0.8], [0.7, 0.3])),
    ]
    for (const a of areas) {
      expect(a).toBeCloseTo(0.25, 12)
      expect(a).toBeGreaterThan(0)
    }
  })

  it('always has four points and starts at the top left corner', () => {
    const r = rectPolygon([0.9, 0.9], [0.1, 0.1])
    expect(r).toHaveLength(4)
    expect(r[0]).toEqual([0.1, 0.1])
  })

  it('clamps corners dragged off the plan into 0..1', () => {
    expect(rectPolygon([-0.5, 0.5], [1.4, 2])).toEqual([
      [0, 0.5],
      [1, 0.5],
      [1, 1],
      [0, 1],
    ])
  })

  it('degenerates to a zero area rectangle when both corners match', () => {
    const r = rectPolygon([0.4, 0.4], [0.4, 0.4])
    expect(r).toEqual([
      [0.4, 0.4],
      [0.4, 0.4],
      [0.4, 0.4],
      [0.4, 0.4],
    ])
    expect(polygonArea(r)).toBe(0)
    expect(Number.isNaN(centroid(r)[0])).toBe(false)
  })
})

describe('expandForTouch', () => {
  const W = 1000
  const H = 1000
  const MIN = 44

  function pixelSize(poly: Polygon, w = W, h = H): { w: number; h: number } {
    const bb = boundingBox(poly)
    return { w: bb.w * w, h: bb.h * h }
  }

  it('grows a thin vertical sliver to the minimum touch width', () => {
    const sliver = rectPolygon([0.5, 0.2], [0.502, 0.8]) // 2 px by 600 px
    expect(pixelSize(sliver).w).toBeCloseTo(2, 6)

    const hit = expandForTouch(sliver, MIN, W, H)
    const size = pixelSize(hit)
    expect(size.w).toBeGreaterThanOrEqual(MIN - 1e-9)
    expect(size.w).toBeCloseTo(MIN, 6)
    expect(size.h).toBeCloseTo(600, 6) // the ample axis is untouched
  })

  it('grows a thin horizontal sliver to the minimum touch height', () => {
    const rod = rectPolygon([0.1, 0.5], [0.9, 0.505]) // 800 px by 5 px
    const hit = expandForTouch(rod, MIN, W, H)
    const size = pixelSize(hit)
    expect(size.h).toBeCloseTo(MIN, 6)
    expect(size.w).toBeCloseTo(800, 6)
  })

  it('expands about the centroid, so the shape stays put', () => {
    const sliver = rectPolygon([0.5, 0.2], [0.502, 0.8])
    const before = centroid(sliver)
    const after = centroid(expandForTouch(sliver, MIN, W, H))
    expectPointClose(after, before)
  })

  it('keeps the original polygon inside the hit polygon', () => {
    const sliver = rectPolygon([0.5, 0.2], [0.502, 0.8])
    const hit = expandForTouch(sliver, MIN, W, H)
    for (const v of sliver) {
      expect(pointInPolygon(v, hit)).toBe(true)
    }
  })

  it('leaves a polygon that already clears the minimum alone', () => {
    const big = rectPolygon([0.1, 0.1], [0.9, 0.9]) // 800 px square
    expect(expandForTouch(big, MIN, W, H)).toEqual(big)

    const l = expandForTouch(L_SHAPE, MIN, W, H)
    expect(l).toEqual(L_SHAPE)
  })

  it('never shrinks: a polygon exactly at the minimum is unchanged', () => {
    const exact = rectPolygon([0, 0], [MIN / W, MIN / H]) // exactly 44 px square
    expect(pixelSize(exact).w).toBeCloseTo(MIN, 9)
    expect(expandForTouch(exact, MIN, W, H)).toEqual(exact)
  })

  it('only grows the axis that needs it', () => {
    const thin = rectPolygon([0.2, 0.2], [0.21, 0.9]) // 10 px by 700 px
    const hit = expandForTouch(thin, MIN, W, H)
    const size = pixelSize(hit)
    expect(size.w).toBeCloseTo(MIN, 6)
    expect(size.h).toBeCloseTo(700, 6)
  })

  it('grows both axes when both are too small', () => {
    const dot = rectPolygon([0.5, 0.5], [0.51, 0.51]) // 10 px square
    const size = pixelSize(expandForTouch(dot, MIN, W, H))
    expect(size.w).toBeCloseTo(MIN, 6)
    expect(size.h).toBeCloseTo(MIN, 6)
  })

  it('covers a polygon with literally zero width with a rectangle', () => {
    const line: Polygon = [
      [0.5, 0.2],
      [0.5, 0.5],
      [0.5, 0.8],
    ]
    const hit = expandForTouch(line, MIN, W, H)
    const size = pixelSize(hit)
    expect(size.w).toBeCloseTo(MIN, 6)
    expect(size.h).toBeCloseTo(600, 6)
    for (const v of line) {
      expect(pointInPolygon(v, hit)).toBe(true)
    }
  })

  it('covers a polygon collapsed to a single point with a minimum sized square', () => {
    const dot: Polygon = [
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
    ]
    const hit = expandForTouch(dot, MIN, W, H)
    const size = pixelSize(hit)
    expect(size.w).toBeCloseTo(MIN, 6)
    expect(size.h).toBeCloseTo(MIN, 6)
    expect(pointInPolygon([0.5, 0.5], hit)).toBe(true)
  })

  it('accounts for a non square plan, where a normalized unit differs per axis', () => {
    const w = 2000
    const h = 500
    const thin = rectPolygon([0.4, 0.4], [0.6, 0.41]) // 400 px by 5 px
    const hit = expandForTouch(thin, MIN, w, h)
    const size = pixelSize(hit, w, h)
    expect(size.w).toBeCloseTo(400, 6)
    expect(size.h).toBeCloseTo(MIN, 6)
  })

  it('is idempotent once the minimum is met', () => {
    const sliver = rectPolygon([0.5, 0.2], [0.502, 0.8])
    const once = expandForTouch(sliver, MIN, W, H)
    expect(expandForTouch(once, MIN, W, H)).toEqual(once)
  })

  it('does not mutate the polygon it was given', () => {
    const sliver = rectPolygon([0.5, 0.2], [0.502, 0.8])
    const snapshot = JSON.stringify(sliver)
    expandForTouch(sliver, MIN, W, H)
    expect(JSON.stringify(sliver)).toBe(snapshot)
  })

  it('is a no op for a degenerate minimum or an unmeasured plan', () => {
    const sliver = rectPolygon([0.5, 0.2], [0.502, 0.8])
    expect(expandForTouch(sliver, 0, W, H)).toEqual(sliver)
    expect(expandForTouch(sliver, MIN, 0, 0)).toEqual(sliver)
    expect(expandForTouch([], MIN, W, H)).toEqual([])
  })

  it('makes a sliver tappable where the raw polygon was not', () => {
    const sliver = rectPolygon([0.5, 0.2], [0.502, 0.8])
    const thumb: Point = [0.51, 0.5] // 8 px to the right of the shape
    expect(pointInPolygon(thumb, sliver)).toBe(false)
    expect(pointInPolygon(thumb, expandForTouch(sliver, MIN, W, H))).toBe(true)
  })
})
