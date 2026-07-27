/**
 * Header sniffing for uploaded floor plans. Section 5.1.
 *
 * The intrinsic pixel size of the plan is what every stored polygon is
 * normalized against, so it has to be recorded exactly. A raster's own header
 * is the only authority on that: the browser's reported content type is
 * attacker controlled and a JPEG renamed to .png would otherwise silently set
 * the wrong dimensions on the floor row.
 *
 * Everything here is pure, dependency free and reads a handful of bytes. No
 * decoding, so a 25 MB upload costs the same as a 25 KB one.
 */

export type PlanFormat = 'png' | 'jpeg' | 'pdf'

export type Dimensions = { width: number; height: number }

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false
  }
  return true
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1]
}

function u32(bytes: Uint8Array, at: number): number {
  // >>> 0 keeps the result unsigned; a 4 GB wide image is not a thing we accept
  // anyway, but a negative width would slip past a `> 0` check.
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

/** The real format of the bytes, or null if it is not one we accept. */
export function sniffFormat(bytes: Uint8Array): PlanFormat | null {
  if (startsWith(bytes, PNG_MAGIC)) return 'png'
  if (startsWith(bytes, PDF_MAGIC)) return 'pdf'
  // SOI, then the first marker of any JPEG variant.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  return null
}

/**
 * Width and height from the PNG IHDR chunk, which the spec pins to the very
 * first chunk: 8 byte signature, 4 byte length, 4 byte type, then the size.
 */
export function pngSize(bytes: Uint8Array): Dimensions | null {
  if (!startsWith(bytes, PNG_MAGIC) || bytes.length < 24) return null
  // Bytes 12..16 must literally be "IHDR" or this is not a conformant PNG.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null
  const width = u32(bytes, 16)
  const height = u32(bytes, 20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/** Markers that carry no length word and so cannot be skipped by one. */
function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)
}

/**
 * A start-of-frame marker. The C0..CF block is shared with three markers that
 * are emphatically not frame headers, and reading a height out of a Huffman
 * table is how you end up with a 16000 px plan.
 */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

/**
 * Width and height from the first JPEG start-of-frame marker.
 *
 * Walks the segment chain rather than searching for the marker bytes, because
 * 0xFFC0 appears constantly inside entropy coded scan data and a naive search
 * finds that first.
 */
export function jpegSize(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  let i = 2
  while (i + 1 < bytes.length) {
    // Segments may be padded with any number of 0xFF fill bytes.
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    let marker = bytes[i + 1]
    let at = i + 2
    while (marker === 0xff && at < bytes.length) {
      marker = bytes[at]
      at++
    }

    if (marker === 0xd9) return null // end of image, no frame header found
    if (isStandalone(marker)) {
      i = at
      continue
    }
    if (at + 1 >= bytes.length) return null

    const length = u16(bytes, at)
    if (length < 2) return null

    if (isStartOfFrame(marker)) {
      // length, then 1 byte sample precision, then height and width.
      if (at + 7 >= bytes.length) return null
      const height = u16(bytes, at + 3)
      const width = u16(bytes, at + 5)
      if (width <= 0 || height <= 0) return null
      return { width, height }
    }

    if (marker === 0xda) return null // start of scan; no frame header before the image data
    i = at + length
  }
  return null
}

/** Dimensions for whichever raster format the bytes actually are. */
export function rasterSize(bytes: Uint8Array): Dimensions | null {
  const format = sniffFormat(bytes)
  if (format === 'png') return pngSize(bytes)
  if (format === 'jpeg') return jpegSize(bytes)
  return null
}
