import { describe, expect, it } from 'vitest'
import {
  CONTAINER_PROPERTY_SPECS,
  ITEM_PROPERTY_SPECS,
  ITEMS_DATABASE_TITLE,
  LOCATIONS_DATABASE_DESCRIPTION,
  LOCATIONS_DATABASE_TITLE,
  createDatabases,
  discoverDataSource,
  parseNotionId,
  propertiesBody,
  reportProperties,
  verifyConnection,
  type CreateDatabaseInput,
  type NotionDataSourceInfo,
  type NotionDatabaseInfo,
  type NotionPropertyConfig,
  type NotionSetupApi,
} from './setup'
import { CONTAINER_PROPERTY, ITEM_PROPERTY } from './mappers'

/**
 * A fake for the setup surface only.
 *
 * Deliberately separate from `test/fakes/notion.ts`: that one models pages and
 * a query cursor for the conformance suite, and setup never touches a page. The
 * two things worth simulating here are a database holding more than one data
 * source (section 7.2) and a data source whose properties have drifted
 * (section 11 case 10).
 */
class FakeSetupNotion implements NotionSetupApi {
  databases = new Map<string, NotionDatabaseInfo>()
  dataSources = new Map<string, NotionDataSourceInfo>()
  calls: string[] = []
  created: CreateDatabaseInput[] = []
  tokenValid = true

  private seq = 0
  private failures = new Map<string, Error>()

  /** Register a database plus one data source per property bag. */
  addDatabase(
    id: string,
    title: string,
    sources: { id: string; name: string; properties: Record<string, NotionPropertyConfig> }[],
  ) {
    this.databases.set(id, {
      id,
      title,
      url: `https://www.notion.so/${id.replace(/-/g, '')}`,
      dataSources: sources.map((s) => ({ id: s.id, name: s.name })),
    })
    for (const s of sources) {
      this.dataSources.set(s.id, { id: s.id, properties: s.properties })
    }
  }

  failOn(key: string, err: Error) { this.failures.set(key, err) }

  private check(key: string) {
    const err = this.failures.get(key)
    if (err) throw err
  }

  async whoAmI() {
    this.calls.push('whoAmI')
    if (!this.tokenValid) {
      const err = new Error('API token is invalid.') as Error & { status: number }
      err.status = 401
      throw err
    }
    return { botName: 'Storage tracker', workspace: 'Home' }
  }

  async retrieveDatabase(databaseId: string): Promise<NotionDatabaseInfo> {
    this.calls.push(`retrieveDatabase:${databaseId}`)
    this.check(`retrieveDatabase:${databaseId}`)
    const db = this.databases.get(databaseId)
    if (!db) {
      const err = new Error('Could not find database') as Error & { status: number }
      err.status = 404
      throw err
    }
    return structuredClone(db)
  }

  async retrieveDataSource(dataSourceId: string): Promise<NotionDataSourceInfo> {
    this.calls.push(`retrieveDataSource:${dataSourceId}`)
    this.check(`retrieveDataSource:${dataSourceId}`)
    const ds = this.dataSources.get(dataSourceId)
    if (!ds) {
      const err = new Error('Could not find data source') as Error & { status: number }
      err.status = 404
      throw err
    }
    return structuredClone(ds)
  }

  async createDatabase(input: CreateDatabaseInput): Promise<NotionDatabaseInfo> {
    this.calls.push(`createDatabase:${input.title}`)
    this.check(`createDatabase:${input.title}`)
    this.created.push(structuredClone(input))

    const databaseId = `db-${++this.seq}`
    const dataSourceId = `ds-${this.seq}`
    this.addDatabase(databaseId, input.title, [{
      id: dataSourceId,
      name: input.title,
      properties: propertyConfigsFromBody(input.properties),
    }])
    return structuredClone(this.databases.get(databaseId)!)
  }
}

/** Turn a create request body back into the shape a retrieve would report. */
function propertyConfigsFromBody(
  body: Record<string, unknown>,
): Record<string, NotionPropertyConfig> {
  const out: Record<string, NotionPropertyConfig> = {}

  for (const [name, raw] of Object.entries(body)) {
    const config = raw as Record<string, unknown>
    const type = Object.keys(config).find((k) => k !== 'description') ?? ''
    const inner = (config[type] ?? {}) as Record<string, unknown>
    const options = Array.isArray(inner.options) ? inner.options : []

    out[name] = {
      type,
      options: options.map((o) => String((o as { name?: unknown }).name ?? '')),
      relationDataSourceId:
        typeof inner.data_source_id === 'string' ? inner.data_source_id : null,
    }
  }
  return out
}

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

/** A data source whose properties exactly match a spec list. */
function healthy(specs: readonly { name: string; type: string; options?: readonly string[] }[],
  relationTarget?: string): Record<string, NotionPropertyConfig> {
  const out: Record<string, NotionPropertyConfig> = {}
  for (const spec of specs) {
    out[spec.name] = {
      type: spec.type,
      options: [...(spec.options ?? [])],
      relationDataSourceId: spec.type === 'relation' ? (relationTarget ?? null) : null,
    }
  }
  return out
}

// --------------------------------------------------------------------------
// Section 7.2: discoverDataSource
// --------------------------------------------------------------------------

describe('discoverDataSource', () => {
  it('reads data_sources[0].id when there is exactly one', async () => {
    const api = new FakeSetupNotion()
    api.addDatabase(UUID_A, 'Storage items', [{ id: 'ds-items', name: 'Storage items', properties: {} }])

    const result = await discoverDataSource(UUID_A, api)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataSourceId).toBe('ds-items')
    expect(result.databaseId).toBe(UUID_A)
    expect(result.title).toBe('Storage items')
  })

  it('refuses to guess when a database holds more than one data source', async () => {
    const api = new FakeSetupNotion()
    api.addDatabase(UUID_A, 'Storage items', [
      { id: 'ds-one', name: 'Current', properties: {} },
      { id: 'ds-two', name: 'Archive 2024', properties: {} },
    ])

    const result = await discoverDataSource(UUID_A, api)

    expect(result.ok).toBe(false)
    if (result.ok) return
    // The reason is what the UI switches on to render a picker instead of an error.
    expect(result.reason).toBe('multiple_data_sources')
    expect(result.choices.map((c) => c.id)).toEqual(['ds-one', 'ds-two'])
    expect(result.databaseId).toBe(UUID_A)
    // Both names are in the message so the error alone is actionable.
    expect(result.message).toContain('Current')
    expect(result.message).toContain('Archive 2024')
    expect(result.message).toMatch(/will not guess/i)
  })

  it('distinguishes multiple data sources from every other failure', async () => {
    const api = new FakeSetupNotion()
    api.addDatabase(UUID_A, 'Storage items', [
      { id: 'ds-one', name: 'Current', properties: {} },
      { id: 'ds-two', name: 'Archive', properties: {} },
    ])
    api.addDatabase(UUID_B, 'Empty', [])

    const multi = await discoverDataSource(UUID_A, api)
    const none = await discoverDataSource(UUID_B, api)
    const missing = await discoverDataSource('33333333-3333-4333-8333-333333333333', api)
    const garbage = await discoverDataSource('not a notion id', api)

    const reasons = [multi, none, missing, garbage].map((r) => (r.ok ? 'ok' : r.reason))
    expect(reasons).toEqual([
      'multiple_data_sources', 'no_data_source', 'unreachable', 'invalid_id',
    ])
    // Only the ambiguous case carries choices, so the UI cannot show an empty picker.
    for (const r of [none, missing, garbage]) {
      expect(r.ok ? [] : r.choices).toEqual([])
    }
  })

  it('never picks a data source it was not given', async () => {
    const api = new FakeSetupNotion()
    api.addDatabase(UUID_A, 'Storage items', [
      { id: 'ds-one', name: 'Current', properties: {} },
      { id: 'ds-two', name: 'Archive', properties: {} },
    ])

    const result = await discoverDataSource(UUID_A, api)

    expect(result.ok).toBe(false)
    // No field anywhere in the result commits to one of the two.
    expect(JSON.stringify(result)).not.toMatch(/"dataSourceId"/)
  })

  it('accepts a pasted Notion URL as well as a bare id', async () => {
    const api = new FakeSetupNotion()
    api.addDatabase(UUID_A, 'Storage items', [{ id: 'ds-items', name: 'items', properties: {} }])

    const result = await discoverDataSource(
      `https://www.notion.so/workspace/Storage-items-${UUID_A.replace(/-/g, '')}?v=abc123`,
      api,
    )

    expect(result.ok).toBe(true)
  })
})

describe('parseNotionId', () => {
  it('normalizes ids, dashed uuids and URLs to one dashed form', () => {
    const compact = UUID_A.replace(/-/g, '')
    expect(parseNotionId(compact)).toBe(UUID_A)
    expect(parseNotionId(UUID_A)).toBe(UUID_A)
    expect(parseNotionId(`https://www.notion.so/Storage-items-${compact}?v=xyz#top`)).toBe(UUID_A)
    expect(parseNotionId('  ' + UUID_A.toUpperCase() + '  ')).toBe(UUID_A)
  })

  it('returns null when there is no id in there at all', () => {
    expect(parseNotionId('')).toBeNull()
    expect(parseNotionId('https://www.notion.so/my-workspace')).toBeNull()
    expect(parseNotionId('deadbeef')).toBeNull()
  })
})

// --------------------------------------------------------------------------
// Section 7.3: createDatabases
// --------------------------------------------------------------------------

describe('createDatabases', () => {
  it('creates both databases with the section 7.3 schema, locations first', async () => {
    const api = new FakeSetupNotion()

    const result = await createDatabases(UUID_A, api)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Locations must exist before items, because items relates to it.
    expect(api.created.map((c) => c.title)).toEqual([
      LOCATIONS_DATABASE_TITLE, ITEMS_DATABASE_TITLE,
    ])

    const [locations, items] = api.created
    expect(Object.keys(locations.properties).sort())
      .toEqual(Object.values(CONTAINER_PROPERTY).sort())
    expect(Object.keys(items.properties).sort())
      .toEqual(Object.values(ITEM_PROPERTY).sort())

    // The relation points at the locations data source that was just created.
    const location = items.properties[ITEM_PROPERTY.location] as { relation: { data_source_id: string } }
    expect(location.relation.data_source_id).toBe(result.locations.dataSourceId)
  })

  it('puts the overwrite warning in the Storage locations description', async () => {
    const api = new FakeSetupNotion()
    await createDatabases(UUID_A, api)

    const locations = api.created.find((c) => c.title === LOCATIONS_DATABASE_TITLE)
    expect(locations?.description).toBe(LOCATIONS_DATABASE_DESCRIPTION)
    expect(locations?.description).toContain('discarded and overwritten on the next reconcile')
  })

  it('reports a failure instead of throwing', async () => {
    const api = new FakeSetupNotion()
    api.failOn(`createDatabase:${LOCATIONS_DATABASE_TITLE}`,
      Object.assign(new Error('Insufficient permissions'), { status: 403 }))

    const result = await createDatabases(UUID_A, api)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('failed')
    expect(result.message).toContain('Insufficient permissions')
    expect(result.message).toContain('403')
  })
})

// --------------------------------------------------------------------------
// Section 11 case 10: verifyConnection's property report
// --------------------------------------------------------------------------

describe('reportProperties', () => {
  const ctx = { locationsDataSourceId: 'ds-locations' }

  it('passes a data source that matches the spec exactly', () => {
    const { properties, extraProperties } = reportProperties(
      ITEM_PROPERTY_SPECS, healthy(ITEM_PROPERTY_SPECS, 'ds-locations'), ctx,
    )

    expect(properties.every((p) => p.ok)).toBe(true)
    expect(properties.map((p) => p.name)).toEqual(ITEM_PROPERTY_SPECS.map((s) => s.name))
    expect(extraProperties).toEqual([])
  })

  it('flags a renamed property as missing, and names it', () => {
    const found = healthy(ITEM_PROPERTY_SPECS, 'ds-locations')
    // Exactly what section 11 case 10 describes: a human renames one property.
    found['Item name'] = found[ITEM_PROPERTY.name]
    delete found[ITEM_PROPERTY.name]

    const { properties, extraProperties } = reportProperties(ITEM_PROPERTY_SPECS, found, ctx)
    const name = properties.find((p) => p.name === ITEM_PROPERTY.name)!

    expect(name.ok).toBe(false)
    expect(name.actualType).toBeNull()
    expect(name.detail).toMatch(/missing/i)
    // The rename is visible from both sides: gone from one list, new in the other.
    expect(extraProperties).toEqual(['Item name'])
    // Nothing else is dragged down with it.
    expect(properties.filter((p) => !p.ok).map((p) => p.name)).toEqual([ITEM_PROPERTY.name])
  })

  it('flags a retyped property and reports both types', () => {
    const found = healthy(ITEM_PROPERTY_SPECS, 'ds-locations')
    found[ITEM_PROPERTY.quantity] = { type: 'rich_text', options: [], relationDataSourceId: null }

    const { properties } = reportProperties(ITEM_PROPERTY_SPECS, found, ctx)
    const quantity = properties.find((p) => p.name === ITEM_PROPERTY.quantity)!

    expect(quantity.ok).toBe(false)
    expect(quantity.expectedType).toBe('number')
    expect(quantity.actualType).toBe('rich_text')
    expect(quantity.detail).toContain('rich_text')
    expect(quantity.detail).toContain('number')
  })

  it('flags a relation repointed at the wrong data source', () => {
    const found = healthy(ITEM_PROPERTY_SPECS, 'ds-somewhere-else')

    const { properties } = reportProperties(ITEM_PROPERTY_SPECS, found, ctx)
    const location = properties.find((p) => p.name === ITEM_PROPERTY.location)!

    expect(location.ok).toBe(false)
    // The type is right, so only the target check can catch this one.
    expect(location.actualType).toBe('relation')
    expect(location.detail).toContain('ds-somewhere-else')
    expect(location.detail).toContain('ds-locations')
  })

  it('treats a deleted select option as drift, not breakage', () => {
    const found = healthy(ITEM_PROPERTY_SPECS, 'ds-locations')
    found[ITEM_PROPERTY.syncStatus] = {
      type: 'select', options: ['Synced', 'Pending'], relationDataSourceId: null,
    }

    const { properties } = reportProperties(ITEM_PROPERTY_SPECS, found, ctx)
    const status = properties.find((p) => p.name === ITEM_PROPERTY.syncStatus)!

    // Notion recreates a select option on write, so this must not block a sync.
    expect(status.ok).toBe(true)
    expect(status.missingOptions).toEqual(['Conflict', 'Error'])
    expect(status.detail).toContain('Conflict')
  })

  it('checks the container spec too', () => {
    const found = healthy(CONTAINER_PROPERTY_SPECS)
    delete found[CONTAINER_PROPERTY.appId]

    const { properties } = reportProperties(CONTAINER_PROPERTY_SPECS, found, ctx)

    expect(properties.filter((p) => !p.ok).map((p) => p.name))
      .toEqual([CONTAINER_PROPERTY.appId])
  })
})

describe('verifyConnection', () => {
  function connectedFake() {
    const api = new FakeSetupNotion()
    api.addDatabase(UUID_B, LOCATIONS_DATABASE_TITLE, [{
      id: 'ds-locations',
      name: LOCATIONS_DATABASE_TITLE,
      properties: healthy(CONTAINER_PROPERTY_SPECS),
    }])
    api.addDatabase(UUID_A, ITEMS_DATABASE_TITLE, [{
      id: 'ds-items',
      name: ITEMS_DATABASE_TITLE,
      properties: healthy(ITEM_PROPERTY_SPECS, 'ds-locations'),
    }])
    return api
  }

  const config = {
    itemsDatabaseId: UUID_A,
    itemsDataSourceId: 'ds-items',
    locationsDatabaseId: UUID_B,
    locationsDataSourceId: 'ds-locations',
  }

  it('reports a healthy connection property by property', async () => {
    const report = await verifyConnection(config, connectedFake())

    expect(report.ok).toBe(true)
    expect(report.tokenValid).toBe(true)
    expect(report.workspace).toBe('Home')
    expect(report.items.reachable).toBe(true)
    expect(report.locations.reachable).toBe(true)
    expect(report.items.properties).toHaveLength(ITEM_PROPERTY_SPECS.length)
    expect(report.locations.properties).toHaveLength(CONTAINER_PROPERTY_SPECS.length)
    expect(report.items.url).toContain('notion.so')
  })

  it('fails the whole report on one renamed property, and says which', async () => {
    const api = connectedFake()
    const items = api.dataSources.get('ds-items')!
    items.properties['App identifier'] = items.properties[ITEM_PROPERTY.appId]
    delete items.properties[ITEM_PROPERTY.appId]

    const report = await verifyConnection(config, api)

    expect(report.ok).toBe(false)
    expect(report.items.ok).toBe(false)
    // The other database is untouched, so the blame is unambiguous.
    expect(report.locations.ok).toBe(true)

    const broken = report.items.properties.filter((p) => !p.ok)
    expect(broken.map((p) => p.name)).toEqual([ITEM_PROPERTY.appId])
    expect(report.items.extraProperties).toEqual(['App identifier'])
  })

  it('reports an unreachable database without throwing', async () => {
    const api = connectedFake()
    api.failOn(`retrieveDataSource:ds-items`,
      Object.assign(new Error('Could not find data source'), { status: 404 }))

    const report = await verifyConnection(config, api)

    expect(report.ok).toBe(false)
    expect(report.items.reachable).toBe(false)
    expect(report.items.error).toContain('404')
    expect(report.items.properties).toEqual([])
    expect(report.locations.ok).toBe(true)
  })

  it('notices a data source that is no longer part of its database', async () => {
    const api = connectedFake()
    // A human split the database, and the id we stored is not in it any more.
    api.databases.get(UUID_A)!.dataSources = [{ id: 'ds-brand-new', name: 'Items v2' }]

    const report = await verifyConnection(config, api)

    expect(report.ok).toBe(false)
    expect(report.items.error).toContain('ds-items')
    expect(report.items.error).toMatch(/no longer/i)
  })

  it('says the token was rejected rather than blaming the schema', async () => {
    const api = connectedFake()
    api.tokenValid = false

    const report = await verifyConnection(config, api)

    expect(report.ok).toBe(false)
    expect(report.tokenPresent).toBe(true)
    expect(report.tokenValid).toBe(false)
    expect(report.error).toContain('401')
    // No database was even opened, so no misleading property errors.
    expect(api.calls).toEqual(['whoAmI'])
  })

  it('renders an unconnected household as pending, not broken', async () => {
    const report = await verifyConnection({
      itemsDatabaseId: null, itemsDataSourceId: null,
      locationsDatabaseId: null, locationsDataSourceId: null,
    }, connectedFake())

    expect(report.ok).toBe(false)
    expect(report.tokenValid).toBe(true)
    expect(report.items.configured).toBe(false)
    expect(report.items.error).toContain('not connected')
    expect(report.items.properties).toEqual([])
  })
})

// --------------------------------------------------------------------------
// The two halves must not drift apart
// --------------------------------------------------------------------------

describe('created schema and verified schema agree', () => {
  it('verifies clean against exactly what createDatabases produced', async () => {
    const api = new FakeSetupNotion()
    const created = await createDatabases(UUID_A, api)
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const report = await verifyConnection({
      itemsDatabaseId: created.items.databaseId,
      itemsDataSourceId: created.items.dataSourceId,
      locationsDatabaseId: created.locations.databaseId,
      locationsDataSourceId: created.locations.dataSourceId,
    }, api)

    expect(report.items.properties.filter((p) => !p.ok)).toEqual([])
    expect(report.locations.properties.filter((p) => !p.ok)).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('names every property through the mappers, never a literal', () => {
    // If a name here drifts from mappers.ts the sync breaks silently, so assert
    // the specs are built from the same constants the mappers read.
    expect(ITEM_PROPERTY_SPECS.map((s) => s.name).sort())
      .toEqual(Object.values(ITEM_PROPERTY).sort())
    expect(CONTAINER_PROPERTY_SPECS.map((s) => s.name).sort())
      .toEqual(Object.values(CONTAINER_PROPERTY).sort())

    const body = propertiesBody(ITEM_PROPERTY_SPECS, { locationsDataSourceId: 'ds-locations' })
    // Every property carries its section 7.3 note as a Notion description.
    for (const spec of ITEM_PROPERTY_SPECS) {
      expect((body[spec.name] as { description: string }).description).toBe(spec.notes)
    }
  })
})
