import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Section 7.5. Notion signs every delivery with the same verification token it
 * sent during the one time handshake, as `X-Notion-Signature: sha256=<hex>`.
 *
 * Pure so it can be tested without a request object. The route handler is
 * responsible for passing the RAW body: re-serialising the parsed JSON changes
 * the bytes and the signature will never match.
 */
export function computeSignature(rawBody: string, token: string): string {
  return `sha256=${createHmac('sha256', token).update(rawBody, 'utf8').digest('hex')}`
}

export function verifySignature(
  rawBody: string, header: string | null, token: string | null,
): boolean {
  if (!header || !token) return false
  const expected = computeSignature(rawBody, token)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(header, 'utf8')
  // timingSafeEqual throws on a length mismatch, which is itself a leak of one
  // bit; compare lengths first and always with the constant time primitive.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type NotionWebhookEvent = {
  type?: string
  entity?: { id?: string; type?: string }
  data?: { parent?: { id?: string; type?: string } }
}

/** Event types we act on. Section 7.5 step 4. */
const PAGE_EVENTS = new Set([
  'page.created',
  'page.properties_updated',
  'page.content_updated',
  'page.deleted',
  'page.undeleted',
  'page.moved',
])

export function isPageEvent(type: string | undefined): boolean {
  return Boolean(type && PAGE_EVENTS.has(type))
}

/**
 * A schema change breaks the property mappers, so it is surfaced loudly rather
 * than swallowed. Section 7.5 step 4.
 */
export function isSchemaEvent(type: string | undefined): boolean {
  return Boolean(type && (
    type.startsWith('data_source.schema') || type === 'database.schema_updated'
  ))
}

export function pageIdFromEvent(event: NotionWebhookEvent): string | null {
  const id = event.entity?.id
  if (!id) return null
  if (event.entity?.type && event.entity.type !== 'page') return null
  return id
}
