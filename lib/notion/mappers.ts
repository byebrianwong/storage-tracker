import { isPageTrashed, trashPayload } from '@/lib/notion/client'
import type { ContainerSyncPayload, ItemSyncPayload } from '@/lib/types'

/**
 * Pure property mappers for the two databases in section 7.3. No network, no
 * client, no environment access, so the whole file is unit testable.
 *
 * The contract that matters (section 11 case 10): reading a page must fail
 * loudly when the workspace schema drifts. A renamed or retyped property is a
 * `NotionSchemaError`, never a silent null, because a silent null would be
 * written straight back over good Supabase data on the next pull.
 */

/** Thrown when a Notion page does not match the schema in section 7.3. */
export class NotionSchemaError extends Error {
  /** The property that failed, when the failure is attributable to one. */
  readonly property: string | null

  constructor(message: string, property: string | null = null) {
    super(message)
    this.name = 'NotionSchemaError'
    this.property = property
    Object.setPrototypeOf(this, NotionSchemaError.prototype)
  }
}

/** Storage items property names. Section 7.3, database 1. */
export const ITEM_PROPERTY = {
  name: 'Name',
  location: 'Location',
  quantity: 'Quantity',
  category: 'Category',
  tags: 'Tags',
  notes: 'Notes',
  appId: 'App ID',
  lastSynced: 'Last synced',
  syncStatus: 'Sync status',
} as const

/** Storage locations property names. Section 7.3, database 2. */
export const CONTAINER_PROPERTY = {
  name: 'Name',
  zone: 'Zone',
  shelf: 'Shelf',
  kind: 'Kind',
  appId: 'App ID',
} as const

export const SYNC_STATUS_OPTIONS = ['Synced', 'Pending', 'Conflict', 'Error'] as const
export type NotionSyncStatus = (typeof SYNC_STATUS_OPTIONS)[number]

/** Section 7.3: "Quantity ... Defaults to 1". */
export const DEFAULT_QUANTITY = 1

export type ItemWriteOptions = {
  /** `items.id`, written to the App ID property. */
  appId: string
  /** ISO 8601 timestamp for the Last synced date property. */
  lastSynced: string
  syncStatus: NotionSyncStatus
}

/**
 * Notion rejects a rich text object whose content exceeds 2000 characters, and
 * section 7.7 warns about payload size limits. Split instead of truncating:
 * the reader joins `plain_text` back together, so chunking round-trips exactly.
 */
const RICH_TEXT_LIMIT = 2000

type RichTextWrite = { type: 'text'; text: { content: string } }

function richText(content: string): RichTextWrite[] {
  if (content === '') return []
  const out: RichTextWrite[] = []
  for (let i = 0; i < content.length; i += RICH_TEXT_LIMIT) {
    out.push({ type: 'text', text: { content: content.slice(i, i + RICH_TEXT_LIMIT) } })
  }
  return out
}

/** Notion has no concept of an empty select option, so empty means cleared. */
function selectWrite(name: string | null): { name: string } | null {
  return name !== null && name !== '' ? { name } : null
}

// --------------------------------------------------------------------------
// Outbound: app to Notion
// --------------------------------------------------------------------------

export function itemToNotionProperties(
  payload: ItemSyncPayload,
  opts: ItemWriteOptions,
): Record<string, unknown> {
  return {
    [ITEM_PROPERTY.name]: { title: richText(payload.name) },
    // Single relation per section 7.3. An empty array clears it.
    [ITEM_PROPERTY.location]: {
      relation: payload.location_page_id ? [{ id: payload.location_page_id }] : [],
    },
    [ITEM_PROPERTY.quantity]: { number: payload.quantity },
    [ITEM_PROPERTY.category]: { select: selectWrite(payload.category) },
    [ITEM_PROPERTY.tags]: { multi_select: payload.tags.map((name) => ({ name })) },
    [ITEM_PROPERTY.notes]: { rich_text: richText(payload.notes ?? '') },
    [ITEM_PROPERTY.appId]: { rich_text: richText(opts.appId) },
    [ITEM_PROPERTY.lastSynced]: { date: opts.lastSynced ? { start: opts.lastSynced } : null },
    [ITEM_PROPERTY.syncStatus]: { select: { name: opts.syncStatus } },
  }
}

/**
 * The full create/update request body for an item page: properties plus the
 * trash flag, whose field name changed between API versions and so lives
 * behind `trashPayload` in client.ts (section 7.4 steps 4 and 5).
 *
 * The caller still supplies `parent` on create.
 */
export function itemToNotionPageBody(
  payload: ItemSyncPayload,
  opts: ItemWriteOptions,
): Record<string, unknown> {
  return {
    properties: itemToNotionProperties(payload, opts),
    ...trashPayload(payload.archived),
  }
}

export function containerToNotionProperties(payload: ContainerSyncPayload): Record<string, unknown> {
  return {
    [CONTAINER_PROPERTY.name]: { title: richText(payload.name) },
    [CONTAINER_PROPERTY.zone]: { select: selectWrite(payload.zone) },
    [CONTAINER_PROPERTY.shelf]: { rich_text: richText(payload.shelf) },
    [CONTAINER_PROPERTY.kind]: { select: selectWrite(payload.kind) },
    [CONTAINER_PROPERTY.appId]: { rich_text: richText(payload.app_id) },
  }
}

// --------------------------------------------------------------------------
// Inbound: Notion to app
// --------------------------------------------------------------------------

type PropertyBag = Record<string, unknown>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `an array of length ${value.length}`
  const t = typeof value
  if (t === 'undefined') return 'undefined'
  if (t === 'object') return 'an object'
  if (t === 'string') return `the string ${JSON.stringify(value)}`
  return `the ${t} ${String(value)}`
}

function listNames(props: PropertyBag): string {
  const names = Object.keys(props)
  return names.length === 0 ? '(none)' : names.map((n) => `"${n}"`).join(', ')
}

function pageId(page: unknown): string {
  const id = isPlainObject(page) ? page.id : undefined
  return typeof id === 'string' && id !== '' ? id : '(no id)'
}

function pageProperties(page: unknown): PropertyBag {
  if (!isPlainObject(page)) {
    throw new NotionSchemaError(`Expected a Notion page object, received ${describeValue(page)}.`)
  }
  const props = page.properties
  if (!isPlainObject(props)) {
    throw new NotionSchemaError(
      `Notion page ${pageId(page)} has no "properties" object; found ${describeValue(props)}.`,
    )
  }
  return props
}

/**
 * Pull one property value out of the bag, or throw.
 *
 * Three distinct failures, all loud:
 * - the key is absent, which is what a rename looks like from here,
 * - the property reports a different `type`, which is a retype,
 * - the property reports the right type but carries no value of that type.
 *
 * A property that is present and correctly typed but *empty* is not a failure.
 * Its emptiness is returned to the caller to interpret.
 */
function readProperty(props: PropertyBag, name: string, expected: string): unknown {
  const raw = props[name]

  if (raw === undefined || raw === null) {
    throw new NotionSchemaError(
      `Notion property "${name}" (expected type "${expected}") is missing from the page. ` +
        `The database schema has drifted, most likely a renamed or deleted property. ` +
        `Properties present: ${listNames(props)}.`,
      name,
    )
  }

  if (!isPlainObject(raw)) {
    throw new NotionSchemaError(
      `Notion property "${name}" is not a property object; found ${describeValue(raw)}.`,
      name,
    )
  }

  const actual = raw.type
  if (typeof actual === 'string' && actual !== expected) {
    throw new NotionSchemaError(
      `Notion property "${name}" has type "${actual}", expected "${expected}". ` +
        `The database schema has drifted, the property was retyped.`,
      name,
    )
  }

  if (!(expected in raw)) {
    throw new NotionSchemaError(
      `Notion property "${name}" carries no "${expected}" value; ` +
        `its keys are ${listNames(raw)}.`,
      name,
    )
  }

  return raw[expected]
}

function plainTextOf(node: unknown): string {
  if (!isPlainObject(node)) return ''
  if (typeof node.plain_text === 'string') return node.plain_text
  // Fall back to the write shape, so a body we built round-trips without Notion.
  const text = node.text
  if (isPlainObject(text) && typeof text.content === 'string') return text.content
  return ''
}

/** Title and rich text both reduce to plain text, joined across every chunk. */
function readText(props: PropertyBag, name: string, kind: 'title' | 'rich_text'): string {
  const value = readProperty(props, name, kind)
  if (!Array.isArray(value)) {
    throw new NotionSchemaError(
      `Notion property "${name}" should hold a ${kind} array; found ${describeValue(value)}.`,
      name,
    )
  }
  return value.map(plainTextOf).join('')
}

function readNumber(props: PropertyBag, name: string): number | null {
  const value = readProperty(props, name, 'number')
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new NotionSchemaError(
      `Notion property "${name}" should hold a number; found ${describeValue(value)}.`,
      name,
    )
  }
  return value
}

function readSelect(props: PropertyBag, name: string): string | null {
  const value = readProperty(props, name, 'select')
  if (value === null) return null
  if (!isPlainObject(value)) {
    throw new NotionSchemaError(
      `Notion property "${name}" should hold a select option object; found ${describeValue(value)}.`,
      name,
    )
  }
  const optionName = value.name
  if (optionName === null || optionName === undefined) return null
  if (typeof optionName !== 'string') {
    throw new NotionSchemaError(
      `Notion property "${name}" has a select option whose name is ${describeValue(optionName)}.`,
      name,
    )
  }
  return optionName === '' ? null : optionName
}

function readMultiSelect(props: PropertyBag, name: string): string[] {
  const value = readProperty(props, name, 'multi_select')
  if (value === null) return []
  if (!Array.isArray(value)) {
    throw new NotionSchemaError(
      `Notion property "${name}" should hold a multi_select array; found ${describeValue(value)}.`,
      name,
    )
  }
  const out: string[] = []
  for (const option of value) {
    if (!isPlainObject(option) || typeof option.name !== 'string') {
      throw new NotionSchemaError(
        `Notion property "${name}" has a multi_select entry that is ${describeValue(option)}, ` +
          `expected an object with a string name.`,
        name,
      )
    }
    if (option.name !== '') out.push(option.name)
  }
  return out
}

/** Single relation per section 7.3. Extra targets are ignored, not an error. */
function readRelation(props: PropertyBag, name: string): string | null {
  const value = readProperty(props, name, 'relation')
  if (value === null) return null
  if (!Array.isArray(value)) {
    throw new NotionSchemaError(
      `Notion property "${name}" should hold a relation array; found ${describeValue(value)}.`,
      name,
    )
  }
  if (value.length === 0) return null
  const first = value[0]
  const id = isPlainObject(first) ? first.id : undefined
  if (typeof id !== 'string' || id === '') {
    throw new NotionSchemaError(
      `Notion property "${name}" has a relation entry with no page id; found ${describeValue(first)}.`,
      name,
    )
  }
  return id
}

/**
 * A Notion page becomes the payload we hash and diff against Supabase.
 *
 * Only the two-way properties from section 7.3 are read, since App ID, Last
 * synced and Sync status are app-writes-only and are not part of the payload.
 *
 * Normalizations, all lossless in the direction that matters: an empty title
 * is `''`, an empty Notes is `null`, an empty Category is `null`, an empty
 * Location is `null`, and an empty Quantity is the documented default of 1.
 */
export function notionPageToItemPayload(page: unknown): ItemSyncPayload {
  const props = pageProperties(page)
  const quantity = readNumber(props, ITEM_PROPERTY.quantity)
  const notes = readText(props, ITEM_PROPERTY.notes, 'rich_text')

  return {
    name: readText(props, ITEM_PROPERTY.name, 'title'),
    quantity: quantity ?? DEFAULT_QUANTITY,
    category: readSelect(props, ITEM_PROPERTY.category),
    tags: readMultiSelect(props, ITEM_PROPERTY.tags),
    notes: notes === '' ? null : notes,
    location_page_id: readRelation(props, ITEM_PROPERTY.location),
    archived: isPageTrashed(page),
  }
}

/**
 * The `items.id` stored on the page, or null.
 *
 * Deliberately tolerant about absence, because section 7.5 step 2 uses a
 * missing App ID as the signal for "a human created this row in Notion". It is
 * not tolerant about a *retyped* App ID: that is schema drift, not a new row,
 * and treating it as a new row would duplicate every item in the workspace.
 */
export function readAppId(page: unknown): string | null {
  if (!isPlainObject(page)) return null
  const props = page.properties
  if (!isPlainObject(props)) return null
  if (props[ITEM_PROPERTY.appId] === undefined || props[ITEM_PROPERTY.appId] === null) return null

  const text = readText(props, ITEM_PROPERTY.appId, 'rich_text').trim()
  return text === '' ? null : text
}
