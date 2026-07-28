import { NextResponse, type NextRequest } from 'next/server'
import { supabaseService } from '@/lib/db/service'
import { dispatchDrain } from '@/lib/sync/dispatch'
import {
  verifySignature, isPageEvent, isSchemaEvent, pageIdFromEvent,
  type NotionWebhookEvent,
} from '@/lib/sync/webhook'

/**
 * Section 7.5. Must return 200 within a couple of seconds, so this only
 * verifies, enqueues, and returns. The drain does the real work.
 */
export async function POST(request: NextRequest) {
  // Raw body, not the parsed one, or the HMAC will never match.
  const raw = await request.text()

  let body: NotionWebhookEvent & { verification_token?: string }
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const signature = request.headers.get('x-notion-signature')
  const db = supabaseService()

  // Step 1: the one time handshake. Notion posts the token with no signature.
  if (body.verification_token && !signature) {
    console.warn(
      '[notion webhook] verification token received, paste this into the Notion UI:',
      body.verification_token,
    )
    const { data: config } = await db.from('notion_config').select('household_id').limit(1).maybeSingle()
    if (config) {
      await db.from('notion_secrets').upsert({
        household_id: config.household_id,
        webhook_verification_token: body.verification_token,
        updated_at: new Date().toISOString(),
      })
    }
    return NextResponse.json({ ok: true })
  }

  // Step 2: verify every subsequent delivery. Reading notion_secrets requires
  // the service role; RLS returns nothing to anyone else.
  const { data: secret } = await db
    .from('notion_secrets')
    .select('household_id, webhook_verification_token')
    .not('webhook_verification_token', 'is', null)
    .limit(1)
    .maybeSingle()

  const token = (secret?.webhook_verification_token as string | null)
    ?? process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN
    ?? null

  if (!verifySignature(raw, signature, token)) {
    return NextResponse.json({ error: 'Bad signature' }, { status: 401 })
  }

  const householdId = secret?.household_id as string | undefined
  if (!householdId) {
    return NextResponse.json({ ok: true, note: 'no household configured' })
  }

  // A schema change breaks the mappers. Log loudly, section 7.5 step 4.
  if (isSchemaEvent(body.type)) {
    console.error(
      '[notion webhook] SCHEMA CHANGED on the items data source. The property ' +
      'mappers will fail until they are updated. Event:', body.type,
    )
    await db.from('sync_runs').insert({
      household_id: householdId, kind: 'webhook',
      finished_at: new Date().toISOString(), ok: false,
      stats: { schema_event: body.type },
    })
    return NextResponse.json({ ok: true })
  }

  // Step 3: enqueue and return. Payloads are sparse, so the pull worker fetches
  // the current page state itself.
  if (isPageEvent(body.type)) {
    const pageId = pageIdFromEvent(body)
    if (pageId) {
      await db.from('sync_jobs').insert({
        household_id: householdId,
        direction: 'pull',
        entity_type: 'item',
        notion_page_id: pageId,
        op: 'upsert',
      })

      /*
        Kick the drain without waiting for it, the same way a Server Action
        mutation does.

        Section 7.4 leaves inbound latency to the every-minute cron, but Vercel's
        Hobby plan caps cron jobs at once per day, so a queued pull would sit
        there for up to 24 hours and the "appears within 2 minutes" criterion in
        section 1 would be unmeetable. Dispatching here makes inbound latency
        independent of the cron schedule on any plan, and leaves the cron as what
        section 7.6 says it really is: the safety net, not the mechanism.
      */
      dispatchDrain()
    }
  }

  return NextResponse.json({ ok: true })
}
