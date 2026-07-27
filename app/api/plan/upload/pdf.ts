import 'server-only'
import { access } from 'node:fs/promises'
import { join, sep } from 'node:path'

/**
 * PDF page one to PNG, server side. Section 5.1 step 2.
 *
 * pdfjs-dist ships a Node canvas factory backed by @napi-rs/canvas, so this
 * runs in the route handler with no browser and no client component, which is
 * the whole point of the section: the plan is rasterized once on upload and
 * every later render is a plain <img>.
 */

/** Section 5.1: render at 2x. */
export const PDF_SCALE = 2

/** Section 5.1: and cap the long edge, so an A0 site plan is not a 40 MP PNG. */
export const PDF_MAX_LONG_EDGE = 2400

/** Refuse to decode an embedded image larger than this. Decompression bombs. */
const MAX_IMAGE_PIXELS = 80e6

/**
 * The scale to render at: 2x, reduced just enough that the long edge lands on
 * the cap. Pure, so the cap is testable without a PDF.
 *
 * `width` and `height` are the page's CSS pixel size at scale 1. A degenerate
 * page (a zero dimension, which malformed PDFs do produce) falls back to the
 * nominal scale rather than dividing by zero.
 */
export function pdfRenderScale(
  width: number,
  height: number,
  scale: number = PDF_SCALE,
  maxLongEdge: number = PDF_MAX_LONG_EDGE,
): number {
  const longEdge = Math.max(width, height)
  if (!Number.isFinite(longEdge) || longEdge <= 0) return scale
  const capped = maxLongEdge / longEdge
  // Only ever scale down. A tiny page still gets its full 2x.
  return Math.min(scale, capped)
}

/**
 * Where pdfjs keeps the Type1 metrics for the 14 standard fonts. Without it,
 * Helvetica and friends fall back to a system face: readable, but the glyph
 * advances drift and a tight room label can collide with a wall.
 *
 * Resolved from the working directory rather than `import.meta.url` because
 * this module is bundled, so its own URL points inside `.next`.
 */
async function standardFontDataUrl(): Promise<string | undefined> {
  const dir = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts')
  try {
    await access(dir)
    return dir + sep
  } catch {
    // Not traced into the deployment bundle. System fonts substitute fine.
    return undefined
  }
}

/** The subset of the Node canvas factory's shape that we actually touch. */
type CanvasAndContext = {
  canvas: { width: number; height: number; encode: (format: 'png') => Promise<Buffer> } | null
  context: unknown
}
type CanvasFactory = {
  create: (width: number, height: number) => CanvasAndContext
  destroy: (canvasAndContext: CanvasAndContext) => void
}

export class PdfRenderError extends Error {}

/** Type only, so it never becomes an import the bundler can see. */
type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

/**
 * pdfjs, loaded as a real module from node_modules rather than as a bundled
 * chunk.
 *
 * It reaches its canvas backend with
 * `createRequire(import.meta.url)('@napi-rs/canvas')`, which is opaque to any
 * bundler and so resolves from wherever the module physically sits at runtime.
 * Bundled, that is `.next/server/chunks`, and under pnpm the package is nested
 * inside pdfjs's own directory, so the require misses and every PDF fails with
 * "Cannot load @napi-rs/canvas". Left external, `import.meta.url` points at the
 * real file and the nested resolution works.
 *
 * The comments are the supported way to say "leave this import alone" to both
 * bundlers. The durable fix is `serverExternalPackages: ['pdfjs-dist']` in
 * next.config.ts, which also gets the package traced into a deployment; this
 * keeps the route correct without owning that file.
 */
async function loadPdfjs(): Promise<Pdfjs> {
  try {
    return (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */
      'pdfjs-dist/legacy/build/pdf.mjs'
    )) as Pdfjs
  } catch (cause) {
    throw new PdfRenderError(
      'The PDF renderer is not available on this server. Export page 1 as a PNG and upload that instead.',
      { cause },
    )
  }
}

/**
 * Rasterize page one. Returns the PNG bytes and the pixel size they were
 * rendered at, which becomes `floors.plan_width` and `floors.plan_height`.
 *
 * The import is deferred so a PNG upload never pays to load pdfjs and its
 * native canvas binding.
 */
export async function renderPdfFirstPageToPng(
  data: Uint8Array,
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const pdfjs = await loadPdfjs()

  const loadingTask = pdfjs.getDocument({
    // pdfjs takes ownership of the buffer and detaches it, so hand over a copy.
    data: new Uint8Array(data),
    standardFontDataUrl: await standardFontDataUrl(),
    // Untrusted input. XFA is a whole second rendering engine we have no use
    // for, and an unbounded embedded image is the cheap way to OOM this route.
    // pdfjs 6 dropped its eval based compilers, so there is no longer an
    // `isEvalSupported` to turn off.
    enableXfa: false,
    maxImageSize: MAX_IMAGE_PIXELS,
  })

  try {
    const doc = await loadingTask.promise
    if (doc.numPages < 1) throw new PdfRenderError('That PDF has no pages')

    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: pdfRenderScale(base.width, base.height) })

    const width = Math.max(1, Math.ceil(viewport.width))
    const height = Math.max(1, Math.ceil(viewport.height))

    const factory = doc.canvasFactory as CanvasFactory
    // This is where a missing @napi-rs/canvas surfaces, as a bare require
    // failure from deep inside pdfjs. Give the user something to act on.
    let target: CanvasAndContext
    try {
      target = factory.create(width, height)
    } catch (cause) {
      throw new PdfRenderError(
        'The PDF renderer is not available on this server. Export page 1 as a PNG and upload that instead.',
        { cause },
      )
    }
    if (!target.canvas) throw new PdfRenderError('Could not create a canvas to render the PDF')

    try {
      await page.render({ canvas: target.canvas as never, viewport }).promise
      const png = new Uint8Array(await target.canvas.encode('png'))
      return { png, width, height }
    } finally {
      page.cleanup()
      factory.destroy(target)
    }
  } finally {
    // Tears down the fake worker too. Skipping this leaks a task per upload.
    await loadingTask.destroy()
  }
}
