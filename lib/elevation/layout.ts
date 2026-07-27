import type { ZoneWithLayout } from '@/lib/types'

/**
 * Deterministic elevation layout. Section 6.
 *
 * The elevation is pure output of the data: no stored coordinates, no manual
 * layout. Same zone in, same drawing out. All of the arithmetic lives here so
 * the renderer stays a dumb mapping from this to SVG, and so the layout can be
 * asserted in a unit test without a DOM.
 */

export const VIEW_W = 1000
export const BASE_ROW_H = 150
export const FRAME_PAD = 10
export const TOP_PAD = 40
export const BOTTOM_PAD = 28
/** Left gutter, reserved for the height dimension line in direction A. */
export const LEFT_GUTTER = 46
export const SHELF_LABEL_H = 20
export const BOARD_GAP = 10
/** Horizontal breathing room between neighbouring containers, in user units. */
export const CELL_INSET = 5

export type LaidOutContainer = {
  id: string
  label: string
  kind: string
  colorTag: string | null
  itemCount: number
  x: number
  y: number
  w: number
  h: number
}

export type LaidOutShelf = {
  id: string
  name: string
  labelY: number
  boardY: number
  containers: LaidOutContainer[]
}

export type ElevationLayout = {
  width: number
  height: number
  frame: { x: number; y: number; w: number; h: number }
  shelves: LaidOutShelf[]
  /** Height dimension, direction A only. Inches derived from row units. */
  dimension: { x: number; y1: number; y2: number; label: string }
  contentW: number
}

/** Nominal inches per row unit, used only for the drafting dimension callout. */
const INCHES_PER_UNIT = 26

export function layoutElevation(zone: ZoneWithLayout): ElevationLayout {
  const cols = Math.max(1, zone.grid_cols)
  const contentW = VIEW_W - LEFT_GUTTER - FRAME_PAD * 2

  const shelves = [...zone.shelves].sort((a, b) => a.row_index - b.row_index)
  const totalUnits = shelves.reduce((sum, s) => sum + Math.max(1, s.height_units), 0)
  const bodyH = totalUnits * BASE_ROW_H
  const height = TOP_PAD + bodyH + BOTTOM_PAD

  let cursorY = TOP_PAD
  const laidOut: LaidOutShelf[] = shelves.map((shelf) => {
    const rowH = Math.max(1, shelf.height_units) * BASE_ROW_H
    const y0 = cursorY
    cursorY += rowH

    const boardY = y0 + rowH - BOARD_GAP
    const boxY = y0 + SHELF_LABEL_H
    const boxH = rowH - SHELF_LABEL_H - BOARD_GAP

    const containers = shelf.containers.map((c) => {
      // Gaps are allowed and meaningful: position comes straight from col_start,
      // never from packing the row.
      const x = LEFT_GUTTER + FRAME_PAD + (c.col_start / cols) * contentW + CELL_INSET
      const w = (c.col_span / cols) * contentW - CELL_INSET * 2
      return {
        id: c.id,
        label: c.label,
        kind: c.kind,
        colorTag: c.color_tag,
        itemCount: c.item_count,
        x,
        y: boxY,
        w: Math.max(w, 8),
        h: boxH,
      }
    })

    return {
      id: shelf.id,
      name: shelf.name,
      labelY: y0 + 13,
      boardY,
      containers,
    }
  })

  return {
    width: VIEW_W,
    height,
    frame: {
      x: LEFT_GUTTER,
      y: TOP_PAD - FRAME_PAD,
      w: contentW + FRAME_PAD * 2,
      h: bodyH + FRAME_PAD,
    },
    shelves: laidOut,
    dimension: {
      x: LEFT_GUTTER - 20,
      y1: TOP_PAD,
      y2: TOP_PAD + bodyH - BOARD_GAP,
      label: `${totalUnits * INCHES_PER_UNIT}″`,
    },
    contentW,
  }
}
