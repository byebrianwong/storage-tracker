/**
 * Shelf layout validation. Section 6.
 *
 * The elevation view is deterministic output of the data, so the only way a
 * shelf can be wrong is if its containers claim overlapping columns or fall
 * outside the grid. Gaps are not an error: a half empty shelf draws half empty,
 * which is information.
 *
 * Every message names the container ids involved so the editor can highlight
 * exactly the cells at fault.
 */
import type { Container } from '@/lib/types'

/** The only fields of a container that the shelf layout depends on. */
type ShelfContainer = Pick<Container, 'id' | 'col_start' | 'col_span'>

type Span = { id: string; start: number; end: number }

export function validateShelf(
  containers: ShelfContainer[],
  gridCols: number,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const gridOk = Number.isInteger(gridCols) && gridCols >= 1
  if (!gridOk) {
    errors.push(`Shelf grid column count must be a whole number of at least 1, got ${gridCols}.`)
  }

  // Containers whose own numbers are sane. A container with a broken span has
  // no meaningful interval, so it is reported once and left out of the overlap
  // sweep rather than generating a second, derivative error.
  const spans: Span[] = []

  for (const c of containers) {
    if (!Number.isInteger(c.col_start) || !Number.isInteger(c.col_span)) {
      errors.push(
        `Container ${c.id} has a non integer position ` +
          `(col_start ${c.col_start}, col_span ${c.col_span}); both must be whole numbers.`,
      )
      continue
    }
    if (c.col_span < 1) {
      errors.push(`Container ${c.id} has col_span ${c.col_span}; col_span must be at least 1.`)
      continue
    }
    const end = c.col_start + c.col_span
    if (c.col_start < 0 || (gridOk && end > gridCols)) {
      errors.push(
        `Container ${c.id} spans columns ${c.col_start}..${end}, ` +
          `which is outside the 0..${gridCols} grid.`,
      )
      continue
    }
    spans.push({ id: c.id, start: c.col_start, end })
  }

  // Sorted sweep, so the reported pairs are stable no matter what order the
  // rows arrived in.
  const sorted = [...spans].sort(
    (a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]
      // Sorted by start, so once one candidate clears a's end, all later ones do.
      if (b.start >= a.end) break
      const from = Math.max(a.start, b.start)
      const to = Math.min(a.end, b.end)
      errors.push(`Containers ${a.id} and ${b.id} overlap on columns ${from}..${to}.`)
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
