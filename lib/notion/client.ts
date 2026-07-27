import 'server-only'
import { Client } from '@notionhq/client'

/**
 * The one place the Notion API version is pinned. Section 7.2.
 *
 * 2026-03-11 exists and is the newest stable version, but @notionhq/client
 * 5.23.2 (the current latest) still defaults to and types against 2025-09-03.
 * The only 2026-03-11 change that touches our surface is the `archived` to
 * `in_trash` rename, which is exactly the field the archive path in 7.4 and the
 * archived detection in 7.5 depend on. Pinning ahead of the SDK's types would
 * break that path silently, so we stay on 2025-09-03.
 *
 * To upgrade: bump this constant, flip TRASH_FIELD, and the two helpers below
 * are the only call sites that need to change.
 */
export const NOTION_VERSION = '2025-09-03' as const

/** `archived` on 2025-09-03, `in_trash` on 2026-03-11 and later. */
const TRASH_FIELD: 'archived' | 'in_trash' = 'archived'

/** Build the request body that moves a page to the trash. */
export function trashPayload(trashed: boolean): Record<string, boolean> {
  return { [TRASH_FIELD]: trashed }
}

/** Read trash state from a page, tolerant of either field being present. */
export function isPageTrashed(page: unknown): boolean {
  const p = page as Record<string, unknown> | null
  if (!p) return false
  return p.in_trash === true || p.archived === true
}

export type NotionClient = Client

let cached: Client | null = null

/** The shared client. Throws if NOTION_TOKEN is unset, so callers gate on isNotionConfigured(). */
export function notionClient(): Client {
  const auth = process.env.NOTION_TOKEN
  if (!auth) {
    throw new Error('NOTION_TOKEN is not set. Notion sync is disabled until it is.')
  }
  if (!cached) {
    cached = new Client({ auth, notionVersion: NOTION_VERSION })
  }
  return cached
}

export function isNotionConfigured(): boolean {
  return Boolean(process.env.NOTION_TOKEN)
}

/** Reset the memoized client. Tests only. */
export function __resetNotionClient() {
  cached = null
}

/**
 * Notion errors we treat as permanent. A 400 almost always means the schema
 * drifted, and retrying a validation error just burns quota. Section 7.7.
 */
export function isPermanentNotionError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  return status === 400 || status === 403 || status === 404
}

export function isRateLimited(err: unknown): boolean {
  return (err as { status?: number })?.status === 429
}

/** Seconds to wait, from a 429's Retry-After header. */
export function retryAfterSeconds(err: unknown): number | null {
  const headers = (err as { headers?: Record<string, string> })?.headers
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After']
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : null
}
