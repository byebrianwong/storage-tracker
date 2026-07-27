import 'server-only'
import { NOTION_VERSION, isNotionConfigured, notionClient } from './client'
import { notionLimiter } from './limiter'
import { CONTAINER_PROPERTY, ITEM_PROPERTY, SYNC_STATUS_OPTIONS } from './mappers'
import { CONTAINER_KINDS } from '@/lib/types'

/**
 * One time connection setup for the two databases in section 7.3, plus the
 * schema drift report section 11 case 10 wants to see *before* a sync breaks.
 *
 * The mappers own the property names; this file owns their types, their
 * create-time configuration and their verification. Both read the same
 * `ITEM_PROPERTY` / `CONTAINER_PROPERTY` constants, so a rename there is a
 * rename here and the two cannot drift apart.
 *
 * Everything talks to Notion through the narrow `NotionSetupApi` below rather
 * than the SDK, for the same reason `lib/notion/api.ts` does: the tests run the
 * real logic against an in-memory fake and only the network is swapped out.
 */

// --------------------------------------------------------------------------
// The narrow Notion surface setup needs
// --------------------------------------------------------------------------

export type NotionDataSourceRef = { id: string; name: string }

export type NotionDatabaseInfo = {
  id: string
  title: string
  url: string | null
  /** Section 7.2: a database is a container of one *or more* data sources. */
  dataSources: NotionDataSourceRef[]
}

export type NotionPropertyConfig = {
  type: string
  /** Select and multi-select option names, empty for every other type. */
  options: string[]
  /** The data source a relation points at, null for every other type. */
  relationDataSourceId: string | null
}

export type NotionDataSourceInfo = {
  id: string
  properties: Record<string, NotionPropertyConfig>
}

export type CreateDatabaseInput = {
  parentPageId: string
  title: string
  description: string
  properties: Record<string, unknown>
}

export interface NotionSetupApi {
  /** Cheapest possible "does this token work" probe. */
  whoAmI(): Promise<{ botName: string | null; workspace: string | null }>
  retrieveDatabase(databaseId: string): Promise<NotionDatabaseInfo>
  retrieveDataSource(dataSourceId: string): Promise<NotionDataSourceInfo>
  createDatabase(input: CreateDatabaseInput): Promise<NotionDatabaseInfo>
}

// --------------------------------------------------------------------------
// Section 7.3: the schema this app creates and owns
// --------------------------------------------------------------------------

export const ITEMS_DATABASE_TITLE = 'Storage items'
export const LOCATIONS_DATABASE_TITLE = 'Storage locations'

export const ITEMS_DATABASE_DESCRIPTION =
  'Items in your home storage. Edit Name, Location, Quantity, Category, Tags and Notes here; ' +
  'changes sync back to the app. App ID, Last synced and Sync status are written by the app.'

/** Section 7.3 requires this exact sentence to be visible to a human in Notion. */
export const LOCATIONS_DATABASE_DESCRIPTION =
  'Edits made to Storage locations rows in Notion are discarded and overwritten on the next reconcile.'

export type PropertyDirection = 'two way' | 'app writes only'

export type PropertySpec = {
  /** The name the mappers read and write. */
  name: string
  /** The Notion property type, as reported by `properties[name].type`. */
  type: string
  direction: PropertyDirection
  /** The Notes column from the section 7.3 tables, used as the Notion property description. */
  notes: string
  /**
   * Select and multi-select options the app seeds. Not required at verify time:
   * Notion creates a select option on first write by name, so a deleted option
   * is drift worth reporting, not a broken sync.
   */
  options?: readonly string[]
  /** Create-time configuration body, minus the type key. */
  config: (ctx: { locationsDataSourceId: string }) => Record<string, unknown>
  /** Extra verification beyond presence and type. Returns a problem, or null. */
  verify?: (found: NotionPropertyConfig, ctx: VerifyContext) => string | null
}

export type VerifyContext = { locationsDataSourceId: string | null }

const SYNC_STATUS_COLOR: Record<string, string> = {
  Synced: 'green', Pending: 'yellow', Conflict: 'red', Error: 'red',
}

/** `{ select: { options: [...] } }`, with a colour where we have an opinion. */
function selectConfig(
  kind: 'select' | 'multi_select',
  names: readonly string[],
  colors: Record<string, string> = {},
): Record<string, unknown> {
  return {
    [kind]: {
      options: names.map((name) => {
        const color = colors[name]
        return color ? { name, color } : { name }
      }),
    },
  }
}

/** Section 7.3, database 1. Order matches the table in the handoff. */
export const ITEM_PROPERTY_SPECS: readonly PropertySpec[] = [
  {
    name: ITEM_PROPERTY.name,
    type: 'title',
    direction: 'two way',
    notes: 'Item name',
    config: () => ({ title: {} }),
  },
  {
    name: ITEM_PROPERTY.location,
    type: 'relation',
    direction: 'two way',
    notes: 'Single relation to Storage locations. Required for new rows',
    config: ({ locationsDataSourceId }) => ({
      relation: {
        data_source_id: locationsDataSourceId,
        type: 'single_property',
        single_property: {},
      },
    }),
    verify: (found, ctx) => {
      if (!ctx.locationsDataSourceId) return null
      if (!found.relationDataSourceId) {
        return 'The relation does not report a target data source.'
      }
      if (compactId(found.relationDataSourceId) !== compactId(ctx.locationsDataSourceId)) {
        return `The relation points at data source ${found.relationDataSourceId}, ` +
          `expected the Storage locations data source ${ctx.locationsDataSourceId}. ` +
          'Writing a location would be rejected by Notion.'
      }
      return null
    },
  },
  {
    name: ITEM_PROPERTY.quantity,
    type: 'number',
    direction: 'two way',
    notes: 'Defaults to 1',
    config: () => ({ number: { format: 'number' } }),
  },
  {
    name: ITEM_PROPERTY.category,
    type: 'select',
    direction: 'two way',
    notes: 'New options allowed, they flow back as the item category',
    // Deliberately unseeded: categories are whatever the household types.
    config: () => ({ select: { options: [] } }),
  },
  {
    name: ITEM_PROPERTY.tags,
    type: 'multi_select',
    direction: 'two way',
    notes: 'Free form tags',
    config: () => ({ multi_select: { options: [] } }),
  },
  {
    name: ITEM_PROPERTY.notes,
    type: 'rich_text',
    direction: 'two way',
    notes: 'Plain text only, first block',
    config: () => ({ rich_text: {} }),
  },
  {
    name: ITEM_PROPERTY.appId,
    type: 'rich_text',
    direction: 'app writes only',
    notes: 'The item uuid. Do not edit',
    config: () => ({ rich_text: {} }),
  },
  {
    name: ITEM_PROPERTY.lastSynced,
    type: 'date',
    direction: 'app writes only',
    notes: 'Written by the app on every push',
    config: () => ({ date: {} }),
  },
  {
    name: ITEM_PROPERTY.syncStatus,
    type: 'select',
    direction: 'app writes only',
    notes: 'Synced, Pending, Conflict, Error. Written by the app',
    options: SYNC_STATUS_OPTIONS,
    config: () => selectConfig('select', SYNC_STATUS_OPTIONS, SYNC_STATUS_COLOR),
  },
]

/** Section 7.3, database 2. Read only by convention, app owned. */
export const CONTAINER_PROPERTY_SPECS: readonly PropertySpec[] = [
  {
    name: CONTAINER_PROPERTY.name,
    type: 'title',
    direction: 'app writes only',
    notes: 'Entry closet / Top shelf / Bin A1a',
    config: () => ({ title: {} }),
  },
  {
    name: CONTAINER_PROPERTY.zone,
    type: 'select',
    direction: 'app writes only',
    notes: 'Entry closet',
    config: () => ({ select: { options: [] } }),
  },
  {
    name: CONTAINER_PROPERTY.shelf,
    type: 'rich_text',
    direction: 'app writes only',
    notes: 'Top shelf',
    config: () => ({ rich_text: {} }),
  },
  {
    name: CONTAINER_PROPERTY.kind,
    type: 'select',
    direction: 'app writes only',
    notes: 'bin, drawer, rod, and so on',
    options: CONTAINER_KINDS,
    config: () => selectConfig('select', CONTAINER_KINDS),
  },
  {
    name: CONTAINER_PROPERTY.appId,
    type: 'rich_text',
    direction: 'app writes only',
    notes: 'The container uuid. Do not edit',
    config: () => ({ rich_text: {} }),
  },
]

/** Build the `properties` body for a create-database call from the specs above. */
export function propertiesBody(
  specs: readonly PropertySpec[],
  ctx: { locationsDataSourceId: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const spec of specs) {
    out[spec.name] = { ...spec.config(ctx), description: spec.notes }
  }
  return out
}

// --------------------------------------------------------------------------
// Id handling
// --------------------------------------------------------------------------

const HEX32 = /[0-9a-f]{32}/gi

/** A Notion id with the dashes stripped, for comparison. */
export function compactId(id: string): string {
  return id.replace(/-/g, '').toLowerCase()
}

/**
 * Accept whatever the user pasted: a bare id, a dashed uuid, or the full URL
 * from Notion's Copy link, and return a dashed uuid. Null when there is no id
 * in there at all, which is the single most common setup mistake.
 */
export function parseNotionId(raw: string): string | null {
  const withoutQuery = raw.trim().split(/[?#]/)[0] ?? ''
  const matches = withoutQuery.replace(/-/g, '').match(HEX32)
  if (!matches || matches.length === 0) return null
  // The last run wins: a Notion URL is `.../Some-Title-<id>`, and a title slug
  // can itself contain hex-looking words.
  const hex = matches[matches.length - 1].toLowerCase()
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20),
  ].join('-')
}

/** The workspace URL for a database or page id. Notion accepts the compact form. */
export function notionUrl(id: string | null): string | null {
  if (!id) return null
  const compact = compactId(id)
  return compact.length === 32 ? `https://www.notion.so/${compact}` : null
}

// --------------------------------------------------------------------------
// Live implementation
// --------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function plainText(nodes: unknown): string {
  if (!Array.isArray(nodes)) return ''
  return nodes
    .map((n) => (isPlainObject(n) && typeof n.plain_text === 'string' ? n.plain_text : ''))
    .join('')
}

/** Tolerant reader: the SDK's response type is a union that may be id-only. */
export function toDatabaseInfo(raw: unknown): NotionDatabaseInfo {
  const db = isPlainObject(raw) ? raw : {}
  const sources = Array.isArray(db.data_sources) ? db.data_sources : []
  return {
    id: typeof db.id === 'string' ? db.id : '',
    title: plainText(db.title),
    url: typeof db.url === 'string' ? db.url : null,
    dataSources: sources.flatMap((s): NotionDataSourceRef[] => {
      if (!isPlainObject(s) || typeof s.id !== 'string') return []
      return [{ id: s.id, name: typeof s.name === 'string' ? s.name : '' }]
    }),
  }
}

export function toDataSourceInfo(raw: unknown): NotionDataSourceInfo {
  const ds = isPlainObject(raw) ? raw : {}
  const props = isPlainObject(ds.properties) ? ds.properties : {}
  const properties: Record<string, NotionPropertyConfig> = {}

  for (const [name, value] of Object.entries(props)) {
    if (!isPlainObject(value)) continue
    const type = typeof value.type === 'string' ? value.type : ''
    const body = isPlainObject(value[type]) ? (value[type] as Record<string, unknown>) : {}
    const rawOptions = Array.isArray(body.options) ? body.options : []

    properties[name] = {
      type,
      options: rawOptions.flatMap((o) =>
        isPlainObject(o) && typeof o.name === 'string' ? [o.name] : []),
      relationDataSourceId:
        type === 'relation' && typeof body.data_source_id === 'string' ? body.data_source_id : null,
    }
  }

  return { id: typeof ds.id === 'string' ? ds.id : '', properties }
}

/** Production implementation. Every call goes through the token bucket, section 7.7. */
export function liveNotionSetupApi(): NotionSetupApi {
  const notion = notionClient()

  return {
    whoAmI: () =>
      notionLimiter.run(async () => {
        const me = (await notion.users.me({})) as unknown as {
          name?: string | null
          bot?: { workspace_name?: string | null }
        }
        return { botName: me.name ?? null, workspace: me.bot?.workspace_name ?? null }
      }),

    retrieveDatabase: (databaseId) =>
      notionLimiter.run(async () =>
        toDatabaseInfo(await notion.databases.retrieve({ database_id: databaseId }))),

    retrieveDataSource: (dataSourceId) =>
      notionLimiter.run(async () =>
        toDataSourceInfo(await notion.dataSources.retrieve({ data_source_id: dataSourceId }))),

    createDatabase: ({ parentPageId, title, description, properties }) =>
      notionLimiter.run(async () =>
        toDatabaseInfo(await notion.databases.create({
          parent: { type: 'page_id', page_id: parentPageId },
          title: [{ type: 'text', text: { content: title } }],
          description: [{ type: 'text', text: { content: description } }],
          initial_data_source: { properties },
        } as never))),
  }
}

function setupApi(api?: NotionSetupApi): NotionSetupApi {
  return api ?? liveNotionSetupApi()
}

/** Notion errors carry a status and a message; surface both, never a stack. */
export function describeNotionError(err: unknown): string {
  const status = (err as { status?: number })?.status
  const message = err instanceof Error ? err.message : String(err)
  return status ? `${message} (HTTP ${status})` : message
}

// --------------------------------------------------------------------------
// Section 7.2: discover the data source behind a database
// --------------------------------------------------------------------------

export type DiscoverFailure =
  /** The string the user pasted contains no Notion id. */
  | 'invalid_id'
  /** NOTION_TOKEN is unset, so nothing can be discovered. */
  | 'not_configured'
  /** Notion refused the retrieve: wrong id, or the integration has no access. */
  | 'unreachable'
  /** A database with no data sources at all, which should not happen. */
  | 'no_data_source'
  /** Section 7.2: "stop and surface a setup error asking the user to pick one". */
  | 'multiple_data_sources'

export type DiscoverResult =
  | {
    ok: true
    databaseId: string
    dataSourceId: string
    title: string
    url: string | null
  }
  | {
    ok: false
    reason: DiscoverFailure
    message: string
    databaseId: string | null
    /** Populated only for `multiple_data_sources`, so the UI can offer a picker. */
    choices: NotionDataSourceRef[]
  }

function discoverFailure(
  reason: DiscoverFailure,
  message: string,
  databaseId: string | null = null,
  choices: NotionDataSourceRef[] = [],
): DiscoverResult {
  return { ok: false, reason, message, databaseId, choices }
}

/**
 * Section 7.2. Take the database id from the user, retrieve the database, read
 * `data_sources[0].id`.
 *
 * The one rule that matters: more than one data source is a hard stop with the
 * candidates attached, never a guess. Picking the wrong one silently would mean
 * every subsequent query reads a data source the household does not own.
 */
export async function discoverDataSource(
  databaseId: string,
  api?: NotionSetupApi,
): Promise<DiscoverResult> {
  const id = parseNotionId(databaseId)
  if (!id) {
    return discoverFailure(
      'invalid_id',
      'That does not look like a Notion database id. Paste the database URL, or the 32 character id from it.',
    )
  }
  if (!api && !isNotionConfigured()) {
    return discoverFailure('not_configured', 'NOTION_TOKEN is not set, so Notion cannot be reached.', id)
  }

  let info: NotionDatabaseInfo
  try {
    info = await setupApi(api).retrieveDatabase(id)
  } catch (err) {
    return discoverFailure(
      'unreachable',
      `Notion could not open database ${id}: ${describeNotionError(err)}. ` +
        'Check the id, and that the integration has been invited to the page.',
      id,
    )
  }

  if (info.dataSources.length === 0) {
    return discoverFailure(
      'no_data_source',
      `Database ${id} reports no data sources. It may have been deleted or moved to the trash.`,
      id,
    )
  }

  if (info.dataSources.length > 1) {
    return discoverFailure(
      'multiple_data_sources',
      `Database "${info.title || id}" holds ${info.dataSources.length} data sources ` +
        `(${info.dataSources.map((s) => s.name || s.id).join(', ')}). ` +
        'Pick the one to sync; the app will not guess.',
      id,
      info.dataSources,
    )
  }

  return {
    ok: true,
    databaseId: info.id || id,
    dataSourceId: info.dataSources[0].id,
    title: info.title,
    url: info.url ?? notionUrl(id),
  }
}

// --------------------------------------------------------------------------
// Section 7.3: the one click "Create databases in Notion" action
// --------------------------------------------------------------------------

export type CreatedDatabase = {
  databaseId: string
  dataSourceId: string
  title: string
  url: string | null
}

export type CreateDatabasesResult =
  | { ok: true; items: CreatedDatabase; locations: CreatedDatabase; parentPageId: string }
  | { ok: false; reason: 'invalid_id' | 'not_configured' | 'failed'; message: string }

/**
 * Create both databases under a parent page the user picked.
 *
 * Locations first, always: the items database carries a Relation whose target
 * is the locations data source, so it cannot be built until that id exists.
 */
export async function createDatabases(
  parentPageId: string,
  api?: NotionSetupApi,
): Promise<CreateDatabasesResult> {
  const parent = parseNotionId(parentPageId)
  if (!parent) {
    return {
      ok: false,
      reason: 'invalid_id',
      message: 'That does not look like a Notion page id. Paste the page URL, or the 32 character id from it.',
    }
  }
  if (!api && !isNotionConfigured()) {
    return { ok: false, reason: 'not_configured', message: 'NOTION_TOKEN is not set, so Notion cannot be reached.' }
  }

  try {
    const client = setupApi(api)

    const locations = await createOne(client, {
      parentPageId: parent,
      title: LOCATIONS_DATABASE_TITLE,
      description: LOCATIONS_DATABASE_DESCRIPTION,
      // No relation in this database, so the context is unused.
      properties: propertiesBody(CONTAINER_PROPERTY_SPECS, { locationsDataSourceId: '' }),
    })

    const items = await createOne(client, {
      parentPageId: parent,
      title: ITEMS_DATABASE_TITLE,
      description: ITEMS_DATABASE_DESCRIPTION,
      properties: propertiesBody(ITEM_PROPERTY_SPECS, {
        locationsDataSourceId: locations.dataSourceId,
      }),
    })

    return { ok: true, items, locations, parentPageId: parent }
  } catch (err) {
    return { ok: false, reason: 'failed', message: describeNotionError(err) }
  }
}

async function createOne(api: NotionSetupApi, input: CreateDatabaseInput): Promise<CreatedDatabase> {
  let info = await api.createDatabase(input)

  // The create response is allowed to be id-only. One extra read beats storing
  // a null data source id and failing on the first drain.
  if (info.dataSources.length === 0 && info.id) {
    info = await api.retrieveDatabase(info.id)
  }
  if (info.dataSources.length === 0) {
    throw new Error(`Notion created "${input.title}" but reported no data source for it.`)
  }

  return {
    databaseId: info.id,
    dataSourceId: info.dataSources[0].id,
    title: info.title || input.title,
    url: info.url ?? notionUrl(info.id),
  }
}

// --------------------------------------------------------------------------
// Section 11 case 10: make schema drift visible before it breaks a sync
// --------------------------------------------------------------------------

export type PropertyReport = {
  name: string
  expectedType: string
  /** Null when the property is missing entirely, which is what a rename looks like. */
  actualType: string | null
  direction: PropertyDirection
  ok: boolean
  /** Seeded options that are no longer present. Notion recreates these on write. */
  missingOptions: string[]
  /** Why it failed, or a non fatal remark. */
  detail: string | null
}

export type DatabaseReport = {
  label: string
  databaseId: string | null
  dataSourceId: string | null
  url: string | null
  configured: boolean
  reachable: boolean
  error: string | null
  properties: PropertyReport[]
  /** Properties a human added. Harmless, but worth showing. */
  extraProperties: string[]
  ok: boolean
}

export type ConnectionReport = {
  ok: boolean
  notionVersion: string
  tokenPresent: boolean
  tokenValid: boolean
  botName: string | null
  workspace: string | null
  error: string | null
  items: DatabaseReport
  locations: DatabaseReport
}

export type ConnectionConfig = {
  itemsDatabaseId: string | null
  itemsDataSourceId: string | null
  locationsDatabaseId: string | null
  locationsDataSourceId: string | null
}

function emptyReport(label: string, databaseId: string | null, dataSourceId: string | null): DatabaseReport {
  return {
    label,
    databaseId,
    dataSourceId,
    url: notionUrl(databaseId),
    configured: Boolean(dataSourceId),
    reachable: false,
    error: null,
    properties: [],
    extraProperties: [],
    ok: false,
  }
}

/**
 * Compare one data source against the specs. Pure, so the interesting half of
 * verification is testable without a client at all.
 */
export function reportProperties(
  specs: readonly PropertySpec[],
  found: Record<string, NotionPropertyConfig>,
  ctx: VerifyContext,
): { properties: PropertyReport[]; extraProperties: string[] } {
  const properties = specs.map((spec): PropertyReport => {
    const actual = found[spec.name]

    if (!actual) {
      return {
        name: spec.name,
        expectedType: spec.type,
        actualType: null,
        direction: spec.direction,
        ok: false,
        missingOptions: [],
        detail: `Missing. A renamed or deleted property stops the sync: the mapper throws ` +
          `rather than writing a null over good data.`,
      }
    }

    if (actual.type !== spec.type) {
      return {
        name: spec.name,
        expectedType: spec.type,
        actualType: actual.type,
        direction: spec.direction,
        ok: false,
        missingOptions: [],
        detail: `Retyped to "${actual.type}". Expected "${spec.type}".`,
      }
    }

    const problem = spec.verify?.(actual, ctx) ?? null
    const missingOptions = (spec.options ?? []).filter((o) => !actual.options.includes(o))

    return {
      name: spec.name,
      expectedType: spec.type,
      actualType: actual.type,
      direction: spec.direction,
      ok: problem === null,
      missingOptions,
      detail: problem
        ?? (missingOptions.length > 0
          ? `Options removed: ${missingOptions.join(', ')}. Notion recreates them on the next write.`
          : null),
    }
  })

  const known = new Set(specs.map((s) => s.name))
  const extraProperties = Object.keys(found).filter((name) => !known.has(name)).sort()

  return { properties, extraProperties }
}

async function verifyOne(
  api: NotionSetupApi,
  label: string,
  databaseId: string | null,
  dataSourceId: string | null,
  specs: readonly PropertySpec[],
  ctx: VerifyContext,
): Promise<DatabaseReport> {
  const report = emptyReport(label, databaseId, dataSourceId)
  if (!dataSourceId) {
    report.error = `${label} is not connected yet.`
    return report
  }

  // The database read is what proves "reachable" in the sense a human means:
  // it is the thing they can click. It also reveals a data source that has been
  // added or removed since setup, which section 7.2 says never to guess about.
  if (databaseId) {
    try {
      const db = await api.retrieveDatabase(databaseId)
      report.url = db.url ?? report.url
      if (db.dataSources.length > 0
        && !db.dataSources.some((s) => compactId(s.id) === compactId(dataSourceId))) {
        report.error = `The connected data source ${dataSourceId} is no longer one of this ` +
          `database's data sources (${db.dataSources.map((s) => s.name || s.id).join(', ')}). ` +
          'Reconnect and pick the right one.'
      } else if (db.dataSources.length > 1) {
        report.error = `This database now holds ${db.dataSources.length} data sources. ` +
          'The app is synced to one of them; confirm it is still the right one.'
      }
    } catch (err) {
      report.error = `Could not open the database: ${describeNotionError(err)}`
      return report
    }
  }

  let source: NotionDataSourceInfo
  try {
    source = await api.retrieveDataSource(dataSourceId)
  } catch (err) {
    report.error = `Could not open the data source: ${describeNotionError(err)}`
    return report
  }

  report.reachable = true
  const { properties, extraProperties } = reportProperties(specs, source.properties, ctx)
  report.properties = properties
  report.extraProperties = extraProperties
  report.ok = report.error === null && properties.every((p) => p.ok)
  return report
}

/**
 * Does the token work, are both databases reachable, and does every property in
 * section 7.3 still exist with the type the mappers expect?
 *
 * Returns a per property report rather than a boolean, because the failure this
 * guards against (section 11 case 10) is a *single* renamed property, and the
 * only useful answer is which one.
 */
export async function verifyConnection(
  config: ConnectionConfig,
  api?: NotionSetupApi,
): Promise<ConnectionReport> {
  const tokenPresent = api ? true : isNotionConfigured()

  const report: ConnectionReport = {
    ok: false,
    notionVersion: NOTION_VERSION,
    tokenPresent,
    tokenValid: false,
    botName: null,
    workspace: null,
    error: null,
    items: emptyReport(ITEMS_DATABASE_TITLE, config.itemsDatabaseId, config.itemsDataSourceId),
    locations: emptyReport(
      LOCATIONS_DATABASE_TITLE, config.locationsDatabaseId, config.locationsDataSourceId,
    ),
  }

  if (!tokenPresent) {
    report.error = 'NOTION_TOKEN is not set. Notion sync is off until it is.'
    return report
  }

  // Built inside the try: a malformed token makes the SDK constructor throw, and
  // this report is rendered by a page that must never 500 over a bad env var.
  let client: NotionSetupApi
  try {
    client = setupApi(api)
    const me = await client.whoAmI()
    report.tokenValid = true
    report.botName = me.botName
    report.workspace = me.workspace
  } catch (err) {
    report.error = `Notion rejected the token: ${describeNotionError(err)}`
    return report
  }

  const ctx: VerifyContext = { locationsDataSourceId: config.locationsDataSourceId }

  report.locations = await verifyOne(
    client, LOCATIONS_DATABASE_TITLE, config.locationsDatabaseId, config.locationsDataSourceId,
    CONTAINER_PROPERTY_SPECS, ctx,
  )
  report.items = await verifyOne(
    client, ITEMS_DATABASE_TITLE, config.itemsDatabaseId, config.itemsDataSourceId,
    ITEM_PROPERTY_SPECS, ctx,
  )

  report.ok = report.items.ok && report.locations.ok
  return report
}
