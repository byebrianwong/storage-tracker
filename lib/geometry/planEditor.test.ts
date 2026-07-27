import { describe, it, expect } from 'vitest'
import type { Point, Polygon } from '@/lib/types'
import { boundingBox, polygonArea } from '@/lib/geometry'
import {
  MIN_RECT_SIDE,
  NUDGE,
  TOUCH_MIN_PX,
  VERTEX_GRAB_PX,
  closeDraft,
  nearestVertex,
  rectFromDrag,
  replaceVertex,
  translatePolygon,
} from '@/components/plan/PlanEditor'
import { pdfRenderScale, PDF_MAX_LONG_EDGE, PDF_SCALE } from '@/app/api/plan/upload/pdf'
import { jpegSize, pngSize, rasterSize, sniffFormat } from '@/app/api/plan/upload/image'

/** A plan whose axes have very different pixel scales, which is the whole point. */
const WIDE = { w: 2000, h: 500 }

const SQUARE: Polygon = [
  [0.2, 0.2],
  [0.6, 0.2],
  [0.6, 0.6],
  [0.2, 0.6],
]

function expectPolygonClose(actual: Polygon, expected: Polygon, digits = 10): void {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(expected[i][0], digits)
    expect(p[1]).toBeCloseTo(expected[i][1], digits)
  })
}

describe('nearestVertex', () => {
  it('returns the index of the corner under the pointer', () => {
    expect(nearestVertex(SQUARE, [0.2, 0.2], VERTEX_GRAB_PX, 1000, 1000)).toBe(0)
    expect(nearestVertex(SQUARE, [0.6, 0.6], VERTEX_GRAB_PX, 1000, 1000)).toBe(2)
  })

  it('returns null when every corner is beyond the grab radius', () => {
    // Dead centre of the square: 0.2 normalized from each corner, which is
    // 200 px on this plan, far past the 22 px radius.
    expect(nearestVertex(SQUARE, [0.4, 0.4], VERTEX_GRAB_PX, 1000, 1000)).toBeNull()
  })

  it('measures in pixels, not normalized units, so a wide plan is not easier to grab', () => {
    // 0.02 along x is 40 px on this plan, 0.02 along y is only 10 px.
    const off: Point = [0.22, 0.2]
    expect(nearestVertex(SQUARE, off, VERTEX_GRAB_PX, WIDE.w, WIDE.h)).toBeNull()

    const down: Point = [0.2, 0.22]
    expect(nearestVertex(SQUARE, down, VERTEX_GRAB_PX, WIDE.w, WIDE.h)).toBe(0)
  })

  it('picks the closest corner when two are within the radius', () => {
    const thin: Polygon = [
      [0.5, 0.5],
      [0.51, 0.5],
      [0.51, 0.51],
    ]
    // Nearer the second corner than the first.
    expect(nearestVertex(thin, [0.509, 0.5], TOUCH_MIN_PX, 1000, 1000)).toBe(1)
  })

  it('has no corner to return for an empty polygon', () => {
    expect(nearestVertex([], [0.5, 0.5], VERTEX_GRAB_PX, 1000, 1000)).toBeNull()
  })
})

describe('rectFromDrag', () => {
  it('normalizes all four drag directions to the same rectangle', () => {
    const a: Point = [0.2, 0.3]
    const b: Point = [0.7, 0.8]
    const expected: Polygon = [
      [0.2, 0.3],
      [0.7, 0.3],
      [0.7, 0.8],
      [0.2, 0.8],
    ]
    for (const [from, to] of [
      [a, b],
      [b, a],
      [[0.7, 0.3], [0.2, 0.8]],
      [[0.2, 0.8], [0.7, 0.3]],
    ] as [Point, Point][]) {
      expectPolygonClose(rectFromDrag(from, to)!, expected)
    }
  })

  it('winds the same way rectPolygon does, so signed area stays positive', () => {
    expect(polygonArea(rectFromDrag([0.7, 0.8], [0.2, 0.3])!)).toBeGreaterThan(0)
  })

  it('rejects a drag too small to have been meant as a rectangle', () => {
    expect(rectFromDrag([0.5, 0.5], [0.5, 0.5])).toBeNull()
    expect(rectFromDrag([0.5, 0.5], [0.5 + MIN_RECT_SIDE / 2, 0.9])).toBeNull()
    expect(rectFromDrag([0.5, 0.5], [0.9, 0.5 + MIN_RECT_SIDE / 2])).toBeNull()
  })

  it('accepts a drag exactly on the threshold', () => {
    const poly = rectFromDrag([0.5, 0.5], [0.5 + MIN_RECT_SIDE, 0.5 + MIN_RECT_SIDE])
    expect(poly).not.toBeNull()
  })

  it('clamps a drag that ran off the plan', () => {
    const poly = rectFromDrag([-0.4, -0.2], [1.6, 1.3])!
    const bb = boundingBox(poly)
    expect(bb.x).toBe(0)
    expect(bb.y).toBe(0)
    expect(bb.w).toBe(1)
    expect(bb.h).toBe(1)
  })
})

describe('translatePolygon', () => {
  it('moves every point by the same delta', () => {
    expectPolygonClose(translatePolygon(SQUARE, 0.1, -0.1), [
      [0.3, 0.1],
      [0.7, 0.1],
      [0.7, 0.5],
      [0.3, 0.5],
    ])
  })

  it('stops at the edge without deforming the shape', () => {
    const moved = translatePolygon(SQUARE, -0.9, 0)
    const before = boundingBox(SQUARE)
    const after = boundingBox(moved)
    expect(after.x).toBeCloseTo(0, 12)
    // The give-away that points were clamped individually would be a squashed
    // box. Width and height have to survive the move untouched.
    expect(after.w).toBeCloseTo(before.w, 12)
    expect(after.h).toBeCloseTo(before.h, 12)
  })

  it('stops at the far edge too', () => {
    const after = boundingBox(translatePolygon(SQUARE, 5, 5))
    expect(after.x + after.w).toBeCloseTo(1, 12)
    expect(after.y + after.h).toBeCloseTo(1, 12)
  })

  it('refuses to move along an axis the polygon cannot legally fit on', () => {
    // Two units wide, so there is no legal x. There is still room in y, and the
    // axes are clamped independently: a shape that is stuck sideways still
    // slides up and down.
    const oversized: Polygon = [
      [-0.5, 0.1],
      [1.5, 0.1],
      [1.5, 0.5],
    ]
    expectPolygonClose(translatePolygon(oversized, 0.2, 0.2), [
      [-0.5, 0.3],
      [1.5, 0.3],
      [1.5, 0.7],
    ])
  })

  it('ignores a non finite delta rather than emitting NaN', () => {
    const moved = translatePolygon(SQUARE, Number.NaN, 0.1)
    expect(moved.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true)
    expect(moved[0][0]).toBeCloseTo(0.2, 12)
  })

  it('returns an empty polygon untouched', () => {
    expect(translatePolygon([], 0.1, 0.1)).toEqual([])
  })
})

describe('replaceVertex', () => {
  it('moves one corner and leaves the rest alone', () => {
    expectPolygonClose(replaceVertex(SQUARE, 1, [0.8, 0.1]), [
      [0.2, 0.2],
      [0.8, 0.1],
      [0.6, 0.6],
      [0.2, 0.6],
    ])
  })

  it('clamps the moved corner into 0..1', () => {
    const moved = replaceVertex(SQUARE, 0, [-3, 42])
    expect(moved[0]).toEqual([0, 1])
  })

  it('nudging by NUDGE lands where arithmetic says it should', () => {
    const nudged = replaceVertex(SQUARE, 0, [SQUARE[0][0] + NUDGE, SQUARE[0][1]])
    expect(nudged[0][0]).toBeCloseTo(0.204, 12)
  })

  it('is a no-op for an index that is not there', () => {
    expect(replaceVertex(SQUARE, -1, [0, 0])).toBe(SQUARE)
    expect(replaceVertex(SQUARE, 9, [0, 0])).toBe(SQUARE)
  })

  it('does not mutate the input', () => {
    const original: Polygon = SQUARE.map((p): Point => [p[0], p[1]])
    replaceVertex(original, 0, [0.9, 0.9])
    expect(original[0]).toEqual([0.2, 0.2])
  })
})

describe('closeDraft', () => {
  it('closes a three point draft', () => {
    const poly = closeDraft([
      [0.1, 0.1],
      [0.5, 0.1],
      [0.3, 0.5],
    ])
    expect(poly).toHaveLength(3)
  })

  it('drops the duplicate point a closing double click leaves behind', () => {
    // click, click, click, then a double click on the last position: the first
    // half of the double click already placed a fourth point.
    const poly = closeDraft([
      [0.1, 0.1],
      [0.5, 0.1],
      [0.3, 0.5],
      [0.3, 0.5],
    ])
    expect(poly).toHaveLength(3)
  })

  it('drops a closing click that landed back on the first point', () => {
    const poly = closeDraft([
      [0.1, 0.1],
      [0.5, 0.1],
      [0.3, 0.5],
      [0.1, 0.1],
    ])
    expect(poly).toHaveLength(3)
    expect(poly![0]).toEqual([0.1, 0.1])
  })

  it('refuses a draft with fewer than three distinct points', () => {
    expect(closeDraft([])).toBeNull()
    expect(closeDraft([[0.1, 0.1]])).toBeNull()
    expect(closeDraft([[0.1, 0.1], [0.4, 0.4]])).toBeNull()
    expect(closeDraft([[0.1, 0.1], [0.1, 0.1], [0.1, 0.1]])).toBeNull()
  })

  it('refuses three collinear points, which have no area to hit test against', () => {
    expect(closeDraft([
      [0.1, 0.1],
      [0.2, 0.2],
      [0.4, 0.4],
    ])).toBeNull()
  })

  it('keeps a concave shape intact', () => {
    const l: Polygon = [
      [0, 0],
      [1, 0],
      [1, 0.5],
      [0.5, 0.5],
      [0.5, 1],
      [0, 1],
    ]
    expect(closeDraft(l)).toHaveLength(6)
  })

  it('does not mutate the draft it was given', () => {
    const draft: Polygon = [[0.1, 0.1], [0.5, 0.1], [0.3, 0.5]]
    const closed = closeDraft(draft)!
    closed[0][0] = 0.9
    expect(draft[0][0]).toBe(0.1)
  })
})

describe('pdfRenderScale', () => {
  it('renders at 2x when that fits under the cap', () => {
    // US Letter at 72 dpi.
    expect(pdfRenderScale(612, 792)).toBe(2)
    expect(792 * pdfRenderScale(612, 792)).toBeLessThanOrEqual(PDF_MAX_LONG_EDGE)
  })

  it('reduces the scale so the long edge lands exactly on the cap', () => {
    // A0 landscape at 72 dpi: 2x would be 6740 px.
    const scale = pdfRenderScale(3370, 2384)
    expect(3370 * scale).toBeCloseTo(PDF_MAX_LONG_EDGE, 6)
    expect(scale).toBeLessThan(PDF_SCALE)
  })

  it('caps on the long edge whichever axis that is', () => {
    const portrait = pdfRenderScale(2384, 3370)
    expect(3370 * portrait).toBeCloseTo(PDF_MAX_LONG_EDGE, 6)
  })

  it('never scales beyond 2x, however small the page', () => {
    expect(pdfRenderScale(100, 80)).toBe(2)
  })

  it('falls back to the nominal scale for a degenerate page', () => {
    expect(pdfRenderScale(0, 0)).toBe(PDF_SCALE)
    expect(pdfRenderScale(Number.NaN, 100)).toBe(PDF_SCALE)
  })
})

/* ------------------------------ header sniffing --------------------------- */

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

/** SOI, one segment of `filler` bytes, then an SOF0 carrying the size. */
function jpegHeader(width: number, height: number, filler: number[] = []): Uint8Array {
  const segment = filler.length > 0
    ? [0xff, 0xfe, 0x00, filler.length + 2, ...filler] // COM, skipped by length
    : []
  return new Uint8Array([
    0xff, 0xd8,
    ...segment,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
  ])
}

describe('sniffFormat', () => {
  it('recognizes the three formats section 5.1 accepts', () => {
    expect(sniffFormat(pngHeader(10, 10))).toBe('png')
    expect(sniffFormat(jpegHeader(10, 10))).toBe('jpeg')
    expect(sniffFormat(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe('pdf')
  })

  it('rejects anything else, including an empty file', () => {
    expect(sniffFormat(new Uint8Array([]))).toBeNull()
    expect(sniffFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull() // GIF
    expect(sniffFormat(new TextEncoder().encode('<svg xmlns="..."'))).toBeNull()
  })

  it('is not fooled by a JPEG that claims to be a PNG by extension', () => {
    // The route trusts this over the browser's content type for exactly this.
    expect(sniffFormat(jpegHeader(640, 480))).toBe('jpeg')
  })
})

describe('pngSize', () => {
  it('reads width and height out of IHDR', () => {
    expect(pngSize(pngHeader(2400, 1600))).toEqual({ width: 2400, height: 1600 })
  })

  it('reads a dimension past the signed 32 bit boundary as positive', () => {
    expect(pngSize(pngHeader(0x80000001, 10))?.width).toBe(0x80000001)
  })

  it('rejects a truncated file, a zero dimension and a missing IHDR', () => {
    expect(pngSize(pngHeader(10, 10).slice(0, 20))).toBeNull()
    expect(pngSize(pngHeader(0, 10))).toBeNull()
    const noIhdr = pngHeader(10, 10)
    noIhdr[12] = 0x50
    expect(pngSize(noIhdr)).toBeNull()
  })
})

describe('jpegSize', () => {
  it('reads width and height out of the start of frame marker', () => {
    expect(jpegSize(jpegHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('skips intervening segments by their length word', () => {
    // The filler contains 0xFFC0, which a naive marker search would find first
    // and read a nonsense size out of.
    expect(jpegSize(jpegHeader(800, 600, [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x02]))).toEqual({
      width: 800,
      height: 600,
    })
  })

  it('tolerates 0xFF fill bytes before a marker', () => {
    const padded = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xff, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03,
    ])
    expect(jpegSize(padded)).toEqual({ width: 400, height: 300 })
  })

  it('gives up rather than guessing when there is no frame header', () => {
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull()
    expect(jpegSize(new Uint8Array([0xff, 0xd8]))).toBeNull()
    expect(jpegSize(pngHeader(10, 10))).toBeNull()
  })
})

describe('rasterSize', () => {
  it('dispatches on the sniffed format, not on anything the caller claims', () => {
    expect(rasterSize(pngHeader(300, 200))).toEqual({ width: 300, height: 200 })
    expect(rasterSize(jpegHeader(300, 200))).toEqual({ width: 300, height: 200 })
  })

  it('has no size to offer for a PDF, which has to be rendered first', () => {
    expect(rasterSize(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBeNull()
  })
})
