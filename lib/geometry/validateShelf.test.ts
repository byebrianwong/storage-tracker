import { describe, it, expect } from 'vitest'
import { validateShelf } from '@/lib/geometry/validateShelf'

type Row = { id: string; col_start: number; col_span: number }

const c = (id: string, col_start: number, col_span: number): Row => ({ id, col_start, col_span })

/** Narrowing helper: fail loudly rather than reading errors off an ok result. */
function errorsOf(result: ReturnType<typeof validateShelf>): string[] {
  expect(result.ok).toBe(false)
  return result.ok ? [] : result.errors
}

describe('validateShelf, valid layouts', () => {
  it('accepts an empty shelf', () => {
    expect(validateShelf([], 12)).toEqual({ ok: true })
  })

  it('accepts containers laid end to end', () => {
    expect(validateShelf([c('a', 0, 4), c('b', 4, 4), c('c', 8, 4)], 12)).toEqual({ ok: true })
  })

  it('accepts gaps: a half empty shelf is information, not an error', () => {
    expect(validateShelf([c('a', 0, 2), c('b', 6, 3)], 12)).toEqual({ ok: true })
    // A single container floating in the middle of an otherwise empty shelf.
    expect(validateShelf([c('lonely', 5, 1)], 12)).toEqual({ ok: true })
    // Leading and trailing gaps.
    expect(validateShelf([c('a', 3, 2)], 12)).toEqual({ ok: true })
  })

  it('accepts a container filling the whole grid', () => {
    expect(validateShelf([c('wide', 0, 12)], 12)).toEqual({ ok: true })
  })

  it('accepts a container ending exactly on the last column', () => {
    expect(validateShelf([c('a', 10, 2)], 12)).toEqual({ ok: true })
  })

  it('accepts the minimum span of 1', () => {
    expect(validateShelf([c('a', 0, 1), c('b', 1, 1)], 2)).toEqual({ ok: true })
  })

  it('does not care what order the rows arrive in', () => {
    expect(validateShelf([c('c', 8, 4), c('a', 0, 4), c('b', 4, 4)], 12)).toEqual({ ok: true })
  })

  it('does not mutate the input array', () => {
    const rows = [c('c', 8, 4), c('a', 0, 4)]
    validateShelf(rows, 12)
    expect(rows.map((r) => r.id)).toEqual(['c', 'a'])
  })
})

describe('validateShelf, overlaps', () => {
  it('rejects two containers that overlap, naming both ids', () => {
    const errors = errorsOf(validateShelf([c('bin-a', 0, 4), c('bin-b', 2, 4)], 12))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('bin-a')
    expect(errors[0]).toContain('bin-b')
    expect(errors[0]).toMatch(/overlap/i)
  })

  it('reports the overlapping column range', () => {
    const errors = errorsOf(validateShelf([c('a', 0, 4), c('b', 2, 4)], 12))
    expect(errors[0]).toContain('2..4')
  })

  it('rejects a container fully contained in another', () => {
    const errors = errorsOf(validateShelf([c('outer', 0, 10), c('inner', 3, 2)], 12))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('outer')
    expect(errors[0]).toContain('inner')
  })

  it('rejects exact duplicates of the same columns', () => {
    const errors = errorsOf(validateShelf([c('a', 4, 2), c('b', 4, 2)], 12))
    expect(errors).toHaveLength(1)
  })

  it('reports one error per overlapping pair', () => {
    // One wide container across three narrow ones: three pairs, and the narrow
    // ones do not touch each other.
    const errors = errorsOf(
      validateShelf([c('wide', 0, 9), c('n1', 0, 3), c('n2', 3, 3), c('n3', 6, 3)], 12),
    )
    expect(errors).toHaveLength(3)
    expect(errors.filter((e) => e.includes('wide'))).toHaveLength(3)
  })

  it('treats touching edges as fine, not overlapping', () => {
    expect(validateShelf([c('a', 0, 3), c('b', 3, 3)], 12)).toEqual({ ok: true })
  })

  it('reports the same overlap regardless of input order', () => {
    const forward = errorsOf(validateShelf([c('a', 0, 4), c('b', 2, 4)], 12))
    const reverse = errorsOf(validateShelf([c('b', 2, 4), c('a', 0, 4)], 12))
    expect(reverse).toEqual(forward)
  })
})

describe('validateShelf, grid bounds', () => {
  it('rejects a negative col_start, naming the id', () => {
    const errors = errorsOf(validateShelf([c('bad', -1, 3)], 12))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('bad')
  })

  it('rejects a container running past the last column', () => {
    const errors = errorsOf(validateShelf([c('overhang', 10, 4)], 12))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('overhang')
    expect(errors[0]).toContain('12')
  })

  it('rejects a col_start at gridCols, which leaves no room for any span', () => {
    expect(validateShelf([c('past-end', 12, 1)], 12).ok).toBe(false)
  })

  it('reports each out of range container separately', () => {
    const errors = errorsOf(validateShelf([c('left', -2, 1), c('right', 11, 5)], 12))
    expect(errors).toHaveLength(2)
    expect(errors.some((e) => e.includes('left'))).toBe(true)
    expect(errors.some((e) => e.includes('right'))).toBe(true)
  })
})

describe('validateShelf, span', () => {
  it('rejects a zero span, naming the id', () => {
    const errors = errorsOf(validateShelf([c('flat', 3, 0)], 12))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('flat')
    expect(errors[0]).toContain('col_span')
  })

  it('rejects a negative span', () => {
    const errors = errorsOf(validateShelf([c('backwards', 3, -2)], 12))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('backwards')
  })

  it('rejects non integer positions, which the column grid cannot represent', () => {
    const errors = errorsOf(validateShelf([c('fractional', 1.5, 2), c('fuzzy', 2, 1.25)], 12))
    expect(errors).toHaveLength(2)
    expect(errors.some((e) => e.includes('fractional'))).toBe(true)
    expect(errors.some((e) => e.includes('fuzzy'))).toBe(true)
  })

  it('rejects NaN, which would otherwise slip through every comparison', () => {
    const errors = errorsOf(validateShelf([c('nan', NaN, 2)], 12))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('nan')
  })

  it('reports a broken span once, without a derivative overlap error', () => {
    const errors = errorsOf(validateShelf([c('good', 0, 4), c('broken', 2, 0)], 12))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('broken')
    expect(errors[0]).not.toMatch(/overlap/i)
  })
})

describe('validateShelf, grid column count', () => {
  it('rejects a grid with no columns', () => {
    const errors = errorsOf(validateShelf([], 0))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/column count/i)
  })

  it('rejects a negative or fractional grid', () => {
    expect(validateShelf([], -4).ok).toBe(false)
    expect(validateShelf([], 12.5).ok).toBe(false)
  })

  it('still checks overlaps when the grid count itself is broken', () => {
    const errors = errorsOf(validateShelf([c('a', 0, 4), c('b', 2, 4)], 0))
    expect(errors).toHaveLength(2)
    expect(errors.some((e) => /column count/i.test(e))).toBe(true)
    expect(errors.some((e) => /overlap/i.test(e))).toBe(true)
  })
})

describe('validateShelf, several problems at once', () => {
  it('accumulates one error per problem so the editor can highlight all of them', () => {
    const errors = errorsOf(
      validateShelf([c('a', 0, 4), c('b', 2, 4), c('c', 20, 2), c('d', 5, 0)], 12),
    )
    expect(errors).toHaveLength(3)
    expect(errors.join('\n')).toContain('c')
    expect(errors.some((e) => /overlap/i.test(e))).toBe(true)
    expect(errors.some((e) => e.includes('outside'))).toBe(true)
    expect(errors.some((e) => e.includes('col_span'))).toBe(true)
  })

  it('returns ok with no errors key when everything is fine', () => {
    const result = validateShelf([c('a', 0, 6), c('b', 6, 6)], 12)
    expect(result).toEqual({ ok: true })
    expect('errors' in result).toBe(false)
  })
})
