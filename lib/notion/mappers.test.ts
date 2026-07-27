import { describe, expect, it, vi } from 'vitest'

// lib/notion/client.ts is a server module. The mappers only pull the pure
// trash-field helpers out of it, so stub the marker package to let the file load.
vi.mock('server-only', () => ({}))

import { trashPayload } from '@/lib/notion/client'
import {
  CONTAINER_PROPERTY,
  ITEM_PROPERTY,
  NotionSchemaError,
  containerToNotionProperties,
  itemToNotionPageBody,
  itemToNotionProperties,
  notionPageToItemPayload,
  readAppId,
} from '@/lib/notion/mappers'
import { payloadHash } from '@/lib/sync/hash'
import type { ContainerSyncPayload, ItemSyncPayload } from '@/lib/types'

const APP_ID = '11111111-2222-4333-8444-555555555555'
const WRITE_OPTS = {
  appId: APP_ID,
  lastSynced: '2026-07-27T10:00:00.000Z',
  syncStatus: 'Synced',
} as const

// --------------------------------------------------------------------------
// Fixture helpers: turn the write shape into the shape the API hands back.
// --------------------------------------------------------------------------

const ANNOTATIONS = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
}

function responseRichText(content: string) {
  return {
    type: 'text',
    text: { content, link: null },
    annotations: ANNOTATIONS,
    plain_text: content,
    href: null,
  }
}

function responseProperty(name: string, write: Record<string, unknown>): Record<string, unknown> {
  const type = Object.keys(write)[0]
  let value = write[type]

  if ((type === 'title' || type === 'rich_text') && Array.isArray(value)) {
    value = value.map((node) => {
      const content = (node as { text: { content: string } }).text.content
      return responseRichText(content)
    })
  } else if (type === 'multi_select' && Array.isArray(value)) {
    value = value.map((option, i) => ({ id: `opt-${i}`, color: 'default', ...(option as object) }))
  } else if (type === 'select' && value !== null) {
    value = { id: 'opt', color: 'default', ...(value as object) }
  }

  return { id: `prop-${name}`, type, [type]: value }
}

/** What Notion returns for a page we just wrote. */
function toNotionPage(
  properties: Record<string, unknown>,
  opts: { id?: string; archived?: boolean } = {},
): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const [name, write] of Object.entries(properties)) {
    props[name] = responseProperty(name, write as Record<string, unknown>)
  }
  return {
    object: 'page',
    id: opts.id ?? 'page-abc',
    created_time: '2026-07-01T00:00:00.000Z',
    last_edited_time: '2026-07-27T10:00:00.000Z',
    ...trashPayload(opts.archived ?? false),
    properties: props,
  }
}

// --------------------------------------------------------------------------
// Hand written fixtures, section 11: empty, maximal, malformed.
// --------------------------------------------------------------------------

/** Every property present, every one of them empty. Legitimate, not an error. */
function emptyPage(): Record<string, unknown> {
  return {
    object: 'page',
    id: 'page-empty',
    archived: false,
    last_edited_time: '2026-07-27T10:00:00.000Z',
    properties: {
      Name: { id: 'title', type: 'title', title: [] },
      Location: { id: 'a', type: 'relation', relation: [], has_more: false },
      Quantity: { id: 'b', type: 'number', number: null },
      Category: { id: 'c', type: 'select', select: null },
      Tags: { id: 'd', type: 'multi_select', multi_select: [] },
      Notes: { id: 'e', type: 'rich_text', rich_text: [] },
      'App ID': { id: 'f', type: 'rich_text', rich_text: [] },
      'Last synced': { id: 'g', type: 'date', date: null },
      'Sync status': { id: 'h', type: 'select', select: null },
    },
  }
}

/** Everything populated, plus the shapes only the real API produces. */
function maximalPage(): Record<string, unknown> {
  return {
    object: 'page',
    id: 'page-maximal',
    archived: true,
    last_edited_time: '2026-07-27T11:30:00.000Z',
    url: 'https://notion.so/page-maximal',
    properties: {
      // A long title arrives split across several rich text nodes.
      Name: {
        id: 'title',
        type: 'title',
        title: [responseRichText('Camping '), responseRichText('gear, bin 3 — «été»')],
      },
      Location: {
        id: 'a',
        type: 'relation',
        // Section 7.3 says single relation. Extra targets are ignored, not fatal.
        relation: [{ id: 'container-page-1' }, { id: 'container-page-2' }],
        has_more: false,
      },
      Quantity: { id: 'b', type: 'number', number: 42 },
      Category: { id: 'c', type: 'select', select: { id: 'o1', name: 'Outdoor', color: 'green' } },
      Tags: {
        id: 'd',
        type: 'multi_select',
        multi_select: [
          { id: 'o2', name: 'seasonal', color: 'blue' },
          { id: 'o3', name: 'bulky', color: 'red' },
          { id: 'o4', name: 'ünïcode 🏕', color: 'default' },
        ],
      },
      Notes: {
        id: 'e',
        type: 'rich_text',
        rich_text: [responseRichText('Line one.\n'), responseRichText('Line two.')],
      },
      'App ID': { id: 'f', type: 'rich_text', rich_text: [responseRichText(APP_ID)] },
      'Last synced': {
        id: 'g',
        type: 'date',
        date: { start: '2026-07-27T10:00:00.000Z', end: null, time_zone: null },
      },
      'Sync status': { id: 'h', type: 'select', select: { id: 'o5', name: 'Conflict', color: 'yellow' } },
      // A property a human added in Notion. We ignore what we do not map.
      'Someone elses column': { id: 'z', type: 'checkbox', checkbox: true },
    },
  }
}

// --------------------------------------------------------------------------

describe('itemToNotionProperties', () => {
  const payload: ItemSyncPayload = {
    name: 'Camping gear',
    quantity: 3,
    category: 'Outdoor',
    tags: ['seasonal', 'bulky'],
    notes: 'Bin is heavy',
    location_page_id: 'container-page-1',
    archived: false,
  }

  it('emits the exact property shape from section 7.3', () => {
    expect(itemToNotionProperties(payload, WRITE_OPTS)).toEqual({
      Name: { title: [{ type: 'text', text: { content: 'Camping gear' } }] },
      Location: { relation: [{ id: 'container-page-1' }] },
      Quantity: { number: 3 },
      Category: { select: { name: 'Outdoor' } },
      Tags: { multi_select: [{ name: 'seasonal' }, { name: 'bulky' }] },
      Notes: { rich_text: [{ type: 'text', text: { content: 'Bin is heavy' } }] },
      'App ID': { rich_text: [{ type: 'text', text: { content: APP_ID } }] },
      'Last synced': { date: { start: '2026-07-27T10:00:00.000Z' } },
      'Sync status': { select: { name: 'Synced' } },
    })
  })

  it('clears rather than blanks when the app value is empty', () => {
    const empty: ItemSyncPayload = {
      name: '',
      quantity: 0,
      category: null,
      tags: [],
      notes: null,
      location_page_id: null,
      archived: false,
    }
    expect(itemToNotionProperties(empty, { ...WRITE_OPTS, syncStatus: 'Pending' })).toEqual({
      Name: { title: [] },
      Location: { relation: [] },
      Quantity: { number: 0 },
      Category: { select: null },
      Tags: { multi_select: [] },
      Notes: { rich_text: [] },
      'App ID': { rich_text: [{ type: 'text', text: { content: APP_ID } }] },
      'Last synced': { date: { start: '2026-07-27T10:00:00.000Z' } },
      'Sync status': { select: { name: 'Pending' } },
    })
  })

  it('splits notes longer than the 2000 character rich text limit', () => {
    const long = 'x'.repeat(4500)
    const props = itemToNotionProperties({ ...payload, notes: long }, WRITE_OPTS)
    const chunks = (props.Notes as { rich_text: { text: { content: string } }[] }).rich_text
    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => c.text.content.length)).toEqual([2000, 2000, 500])
    expect(chunks.map((c) => c.text.content).join('')).toBe(long)
  })

  it('writes the sync status the caller asked for', () => {
    for (const status of ['Synced', 'Pending', 'Conflict', 'Error'] as const) {
      const props = itemToNotionProperties(payload, { ...WRITE_OPTS, syncStatus: status })
      expect(props['Sync status']).toEqual({ select: { name: status } })
    }
  })
})

describe('itemToNotionPageBody', () => {
  const payload: ItemSyncPayload = {
    name: 'Old skis',
    quantity: 1,
    category: null,
    tags: [],
    notes: null,
    location_page_id: null,
    archived: true,
  }

  it('carries the trash flag from client.ts, not a literal', () => {
    const body = itemToNotionPageBody(payload, WRITE_OPTS)
    expect(body).toMatchObject(trashPayload(true))
    expect(body.properties).toEqual(itemToNotionProperties(payload, WRITE_OPTS))
  })

  it('is not trashed when the payload is not archived', () => {
    const body = itemToNotionPageBody({ ...payload, archived: false }, WRITE_OPTS)
    expect(body).toMatchObject(trashPayload(false))
  })
})

describe('containerToNotionProperties', () => {
  it('emits the Storage locations shape from section 7.3', () => {
    const payload: ContainerSyncPayload = {
      name: 'Entry closet / Top shelf / Bin A1a',
      zone: 'Entry closet',
      shelf: 'Top shelf',
      kind: 'bin',
      app_id: APP_ID,
    }
    expect(containerToNotionProperties(payload)).toEqual({
      Name: { title: [{ type: 'text', text: { content: 'Entry closet / Top shelf / Bin A1a' } }] },
      Zone: { select: { name: 'Entry closet' } },
      Shelf: { rich_text: [{ type: 'text', text: { content: 'Top shelf' } }] },
      Kind: { select: { name: 'bin' } },
      'App ID': { rich_text: [{ type: 'text', text: { content: APP_ID } }] },
    })
  })

  it('clears empty selects and text rather than sending an empty option name', () => {
    const payload: ContainerSyncPayload = {
      name: 'Bin',
      zone: '',
      shelf: '',
      kind: '',
      app_id: APP_ID,
    }
    const props = containerToNotionProperties(payload)
    expect(props[CONTAINER_PROPERTY.zone]).toEqual({ select: null })
    expect(props[CONTAINER_PROPERTY.kind]).toEqual({ select: null })
    expect(props[CONTAINER_PROPERTY.shelf]).toEqual({ rich_text: [] })
  })
})

describe('notionPageToItemPayload, empty fixture', () => {
  it('reads a fully empty page without throwing', () => {
    expect(notionPageToItemPayload(emptyPage())).toEqual({
      name: '',
      quantity: 1, // section 7.3, "Defaults to 1"
      category: null,
      tags: [],
      notes: null,
      location_page_id: null,
      archived: false,
    })
  })

  it('treats present-but-empty as a value, not as schema drift', () => {
    expect(() => notionPageToItemPayload(emptyPage())).not.toThrow()
  })
})

describe('notionPageToItemPayload, maximal fixture', () => {
  it('joins split rich text, takes the first relation, and reads the trash flag', () => {
    expect(notionPageToItemPayload(maximalPage())).toEqual({
      name: 'Camping gear, bin 3 — «été»',
      quantity: 42,
      category: 'Outdoor',
      tags: ['seasonal', 'bulky', 'ünïcode 🏕'],
      notes: 'Line one.\nLine two.',
      location_page_id: 'container-page-1',
      archived: true,
    })
  })

  it('ignores properties it does not map', () => {
    const page = maximalPage()
    const props = page.properties as Record<string, unknown>
    props['Yet another column'] = { id: 'y', type: 'url', url: 'https://example.com' }
    expect(notionPageToItemPayload(page).name).toBe('Camping gear, bin 3 — «été»')
  })

  it('reads in_trash as well as archived, so the mapper survives a version bump', () => {
    const page = maximalPage()
    delete page.archived
    page.in_trash = true
    expect(notionPageToItemPayload(page).archived).toBe(true)
  })
})

describe('notionPageToItemPayload, malformed fixtures (section 11 case 10)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'page-abc'],
    ['an array', []],
    ['a number', 7],
  ])('throws when the page is %s', (_label, page) => {
    expect(() => notionPageToItemPayload(page)).toThrow(NotionSchemaError)
  })

  it('throws when the page has no properties object', () => {
    expect(() => notionPageToItemPayload({ object: 'page', id: 'p1' })).toThrow(NotionSchemaError)
    expect(() => notionPageToItemPayload({ id: 'p1', properties: null })).toThrow(/properties/)
    expect(() => notionPageToItemPayload({ id: 'p1', properties: [] })).toThrow(/properties/)
  })

  it('throws, naming the property, when a property is renamed away', () => {
    for (const name of ['Name', 'Location', 'Quantity', 'Category', 'Tags', 'Notes']) {
      const page = maximalPage()
      const props = page.properties as Record<string, unknown>
      props[`${name} (renamed)`] = props[name]
      delete props[name]

      let thrown: unknown
      try {
        notionPageToItemPayload(page)
      } catch (err) {
        thrown = err
      }

      expect(thrown, `renaming ${name} must throw`).toBeInstanceOf(NotionSchemaError)
      const error = thrown as NotionSchemaError
      expect(error.property).toBe(name)
      expect(error.message).toContain(`"${name}"`)
      expect(error.message).toMatch(/missing/i)
      // The rename is visible in the message, so the operator can see what happened.
      expect(error.message).toContain(`${name} (renamed)`)
    }
  })

  it('never silently writes nulls when a property is renamed', () => {
    // The failure mode this suite exists to catch: a renamed Category must not
    // come back as category: null and blank the Supabase row on the next pull.
    const page = maximalPage()
    const props = page.properties as Record<string, unknown>
    props.Categories = props.Category
    delete props.Category

    let payload: ItemSyncPayload | null = null
    try {
      payload = notionPageToItemPayload(page)
    } catch {
      // expected
    }
    expect(payload).toBeNull()
  })

  it.each([
    ['Name', 'rich_text', 'title'],
    ['Location', 'rich_text', 'relation'],
    ['Quantity', 'rich_text', 'number'],
    ['Category', 'multi_select', 'select'],
    ['Tags', 'select', 'multi_select'],
    ['Notes', 'title', 'rich_text'],
  ])('throws when %s is retyped to %s', (name, wrongType, expectedType) => {
    const page = maximalPage()
    const props = page.properties as Record<string, unknown>
    props[name] = { id: 'x', type: wrongType, [wrongType]: null }

    let thrown: unknown
    try {
      notionPageToItemPayload(page)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(NotionSchemaError)
    const error = thrown as NotionSchemaError
    expect(error.property).toBe(name)
    expect(error.message).toContain(`"${name}"`)
    expect(error.message).toContain(`"${wrongType}"`)
    expect(error.message).toContain(`"${expectedType}"`)
  })

  it('throws when a property object carries no value of its declared type', () => {
    const page = maximalPage()
    const props = page.properties as Record<string, unknown>
    props.Tags = { id: 'd', type: 'multi_select' }
    expect(() => notionPageToItemPayload(page)).toThrow(/carries no "multi_select" value/)
  })

  it('throws when a value has the right key but the wrong inner shape', () => {
    const cases: [string, unknown, RegExp][] = [
      ['Quantity', { id: 'b', type: 'number', number: '42' }, /should hold a number/],
      ['Name', { id: 'a', type: 'title', title: 'Camping gear' }, /should hold a title array/],
      ['Tags', { id: 'd', type: 'multi_select', multi_select: ['seasonal'] }, /multi_select entry/],
      ['Category', { id: 'c', type: 'select', select: 'Outdoor' }, /select option object/],
      ['Location', { id: 'a', type: 'relation', relation: [{ page_id: 'x' }] }, /no page id/],
    ]
    for (const [name, value, message] of cases) {
      const page = maximalPage()
      ;(page.properties as Record<string, unknown>)[name] = value
      expect(() => notionPageToItemPayload(page), name).toThrow(message)
    }
  })

  it('throws a real Error subclass, so instanceof and catch blocks behave', () => {
    const error = new NotionSchemaError('boom', 'Tags')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(NotionSchemaError)
    expect(error.name).toBe('NotionSchemaError')
    expect(error.property).toBe('Tags')
  })
})

describe('readAppId', () => {
  it('reads the uuid from a populated page', () => {
    expect(readAppId(maximalPage())).toBe(APP_ID)
  })

  it('returns null when the property is present but empty', () => {
    expect(readAppId(emptyPage())).toBeNull()
  })

  it('returns null when the property is whitespace only', () => {
    const page = emptyPage()
    ;(page.properties as Record<string, unknown>)['App ID'] = {
      id: 'f',
      type: 'rich_text',
      rich_text: [responseRichText('   ')],
    }
    expect(readAppId(page)).toBeNull()
  })

  it('returns null when the property is absent, the human-created-row signal in 7.5', () => {
    const page = emptyPage()
    delete (page.properties as Record<string, unknown>)['App ID']
    expect(readAppId(page)).toBeNull()
  })

  it('returns null for a page-shaped thing it cannot read at all', () => {
    expect(readAppId(null)).toBeNull()
    expect(readAppId('nope')).toBeNull()
    expect(readAppId({ id: 'p' })).toBeNull()
  })

  it('throws when App ID was retyped, since that is drift and not a new row', () => {
    const page = maximalPage()
    ;(page.properties as Record<string, unknown>)['App ID'] = {
      id: 'f',
      type: 'number',
      number: 5,
    }
    expect(() => readAppId(page)).toThrow(NotionSchemaError)
    expect(() => readAppId(page)).toThrow(/"App ID"/)
  })

  it('joins a uuid that Notion split across rich text nodes', () => {
    const page = emptyPage()
    ;(page.properties as Record<string, unknown>)['App ID'] = {
      id: 'f',
      type: 'rich_text',
      rich_text: [responseRichText(APP_ID.slice(0, 8)), responseRichText(APP_ID.slice(8))],
    }
    expect(readAppId(page)).toBe(APP_ID)
  })
})

describe('round trip: payload -> properties -> page -> payload', () => {
  const cases: [string, ItemSyncPayload][] = [
    [
      'fully populated',
      {
        name: 'Camping gear',
        quantity: 3,
        category: 'Outdoor',
        tags: ['seasonal', 'bulky'],
        notes: 'Bin is heavy',
        location_page_id: 'container-page-1',
        archived: false,
      },
    ],
    [
      'all empty',
      {
        name: '',
        quantity: 1,
        category: null,
        tags: [],
        notes: null,
        location_page_id: null,
        archived: false,
      },
    ],
    [
      'archived',
      {
        name: 'Old skis',
        quantity: 1,
        category: 'Sports',
        tags: [],
        notes: null,
        location_page_id: 'container-page-9',
        archived: true,
      },
    ],
    [
      'unicode and newlines',
      {
        name: 'Décorations de Noël 🎄',
        quantity: 12,
        category: 'Séasonal',
        tags: ['ünïcode 🏕', 'fragile'],
        notes: 'Line one.\nLine two.\tTabbed.',
        location_page_id: 'container-page-2',
        archived: false,
      },
    ],
    [
      'notes longer than one rich text chunk',
      {
        name: 'Manual',
        quantity: 1,
        category: null,
        tags: [],
        notes: 'y'.repeat(5000),
        location_page_id: null,
        archived: false,
      },
    ],
    [
      'quantity zero',
      {
        name: 'Out of stock',
        quantity: 0,
        category: null,
        tags: [],
        notes: null,
        location_page_id: null,
        archived: false,
      },
    ],
  ]

  it.each(cases)('is identity for a %s payload', (_label, payload) => {
    const page = toNotionPage(itemToNotionProperties(payload, WRITE_OPTS), {
      archived: payload.archived,
    })
    expect(notionPageToItemPayload(page)).toEqual(payload)
  })

  it.each(cases)('preserves the echo suppression hash for a %s payload', (_label, payload) => {
    const page = toNotionPage(itemToNotionProperties(payload, WRITE_OPTS), {
      archived: payload.archived,
    })
    // Section 7.5 step 3 compares this hash against last_pushed_hash. If the
    // round trip were lossy every push would look like a fresh Notion edit.
    expect(payloadHash(notionPageToItemPayload(page))).toBe(payloadHash(payload))
  })

  it('round trips the App ID we wrote', () => {
    const payload = cases[0][1]
    const page = toNotionPage(itemToNotionProperties(payload, WRITE_OPTS))
    expect(readAppId(page)).toBe(APP_ID)
  })

  it('normalizes an empty string to null on the way back', () => {
    // Documented lossy edge: Notion cannot store "present but empty" for these,
    // so '' and null are the same page. The app side should send null.
    const page = toNotionPage(
      itemToNotionProperties(
        {
          name: 'Thing',
          quantity: 1,
          category: '',
          tags: [],
          notes: '',
          location_page_id: '',
          archived: false,
        },
        WRITE_OPTS,
      ),
    )
    const payload = notionPageToItemPayload(page)
    expect(payload.category).toBeNull()
    expect(payload.notes).toBeNull()
    expect(payload.location_page_id).toBeNull()
  })

  it('uses the property names from section 7.3', () => {
    expect(Object.keys(itemToNotionProperties(cases[0][1], WRITE_OPTS))).toEqual([
      ITEM_PROPERTY.name,
      ITEM_PROPERTY.location,
      ITEM_PROPERTY.quantity,
      ITEM_PROPERTY.category,
      ITEM_PROPERTY.tags,
      ITEM_PROPERTY.notes,
      ITEM_PROPERTY.appId,
      ITEM_PROPERTY.lastSynced,
      ITEM_PROPERTY.syncStatus,
    ])
  })
})
