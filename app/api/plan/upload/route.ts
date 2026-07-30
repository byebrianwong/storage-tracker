import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { supabaseServer, currentHouseholdId } from '@/lib/db/server'
import { rasterSize, sniffFormat, type PlanFormat } from './image'
import { renderPdfFirstPageToPng, PdfRenderError } from './pdf'
import { PLANS_BUCKET } from '@/lib/db/constants'

/**
 * Floor plan upload. Section 5.1.
 *
 * A route handler rather than a Server Action because step 2 rasterizes a PDF
 * with pdfjs-dist and its native canvas binding, which must stay on the Node
 * runtime and must never be reachable from a client component.
 *
 * The response is the `ActionResult` shape the Server Actions use, so callers
 * branch on one discriminant everywhere.
 */
export const runtime = 'nodejs'

/** Rasterizing a dense architectural page is not a 10 second job. */
export const maxDuration = 60

/**
 * Section 5.1. Generous, because a scanned strata plan is a big file.
 *
 * Note that a platform in front of this may cap the request body lower (Vercel
 * serverless functions stop at 4.5 MB). If that bites, the fix is a signed
 * upload straight to Storage plus a rasterize callback, not a smaller cap here.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Declared content types we accept, mapped to the bytes we expect behind them. */
const ACCEPTED: Record<string, PlanFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'application/pdf': 'pdf',
}

/** Some browsers and most `curl` invocations send this for any file. */
const UNSPECIFIED = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

const Body = z.object({
  /** Optional: defaults to the household's first floor, which is all v1 has. */
  floorId: z.uuid().optional(),
})

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status })
}

/** PDFs and PNGs land as .png; a JPEG keeps its own extension and bytes. */
function objectFor(format: PlanFormat): { ext: string; contentType: string } {
  return format === 'jpeg'
    ? { ext: 'jpg', contentType: 'image/jpeg' }
    : { ext: 'png', contentType: 'image/png' }
}

export async function POST(request: NextRequest) {
  const householdId = await currentHouseholdId()
  if (!householdId) return fail('Not signed in', 401)

  // Reject on the declared length before reading the body into memory.
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return fail('That file is over the 25 MB limit', 413)
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return fail('Send the plan as a multipart form upload', 400)
  }

  const parsedBody = Body.safeParse({ floorId: form.get('floorId') ?? undefined })
  if (!parsedBody.success) return fail('Invalid floor', 400)

  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return fail('Choose a PNG, JPG or PDF floor plan', 400)
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail('That file is over the 25 MB limit', 413)
  }

  const declared = (file.type || '').toLowerCase()
  if (!UNSPECIFIED.has(declared) && !(declared in ACCEPTED)) {
    return fail('Floor plans have to be a PNG, JPG or PDF', 415)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return fail('That file is over the 25 MB limit', 413)
  }

  // The header is the authority, not the content type the browser claimed.
  const format = sniffFormat(bytes)
  if (!format) return fail('That file is not a PNG, JPG or PDF', 415)
  const expected = ACCEPTED[declared]
  if (expected && expected !== format) {
    return fail(`That file is named as ${declared} but its contents are not`, 415)
  }

  const supabase = await supabaseServer()

  // RLS already scopes floors to the household; the join keeps a floor id from
  // another household from being addressed at all, and yields home_id for the
  // storage path in the same round trip.
  let query = supabase
    .from('floors')
    .select('id, home_id, plan_path, homes!inner(household_id)')
    .eq('homes.household_id', householdId)
  if (parsedBody.data.floorId) query = query.eq('id', parsedBody.data.floorId)

  const { data: floor, error: floorError } = await query.order('sort_order').limit(1).maybeSingle()
  if (floorError) return fail(floorError.message, 500)
  if (!floor) return fail('No floor to attach this plan to', 404)

  let payload: Uint8Array
  let width: number
  let height: number

  if (format === 'pdf') {
    try {
      const rendered = await renderPdfFirstPageToPng(bytes)
      payload = rendered.png
      width = rendered.width
      height = rendered.height
    } catch (error) {
      const detail = error instanceof PdfRenderError ? error.message : null
      return fail(
        detail ??
          'That PDF could not be rendered. Export page 1 as a PNG and upload that instead.',
        422,
      )
    }
  } else {
    const size = rasterSize(bytes)
    if (!size) return fail('That image is damaged, its header could not be read', 422)
    payload = bytes
    width = size.width
    height = size.height
  }

  const { ext, contentType } = objectFor(format)
  const planPath = `${floor.home_id as string}/${floor.id as string}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from(PLANS_BUCKET)
    .upload(planPath, payload, { contentType, upsert: true, cacheControl: '3600' })
  if (uploadError) return fail(uploadError.message, 502)

  // A JPG replacing a PNG would otherwise leave the old object orphaned in a
  // bucket nothing else ever sweeps.
  const previous = floor.plan_path as string | null
  if (previous && previous !== planPath) {
    await supabase.storage.from(PLANS_BUCKET).remove([previous])
  }

  const { error: updateError } = await supabase
    .from('floors')
    .update({ plan_path: planPath, plan_width: width, plan_height: height })
    .eq('id', floor.id as string)
  if (updateError) return fail(updateError.message, 500)

  revalidatePath('/plan')
  revalidatePath('/setup/plan')

  return NextResponse.json({
    ok: true,
    data: { planPath, width, height, floorId: floor.id as string },
  })
}
