import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJson, payloadHash } from '@/lib/sync/hash'
import type { ItemSyncPayload } from '@/lib/types'

describe('canonicalJson, key order stability (section 11)', () => {
  it('is byte identical for objects built in different key orders', () => {
    const a = { b: 1, a: 2, c: 3 }
    const b = { c: 3, a: 2, b: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe('{"a":2,"b":1,"c":3}')
  })

  it('sorts keys at every nesting depth, not just the top level', () => {
    const first = {
      zeta: 1,
      alpha: {
        inner_z: [1, 2, { deep_z: true, deep_a: 'x' }],
        inner_a: { leaf_z: null, leaf_m: 0, leaf_a: 'v' },
      },
      middle: { m2: { m2b: 2, m2a: 1 }, m1: 'one' },
    }

    // Same value, every object literal written in a different key order, and at
    // a different depth. Nothing here may reach the hash.
    const second = {
      middle: { m1: 'one', m2: { m2a: 1, m2b: 2 } },
      alpha: {
        inner_a: { leaf_a: 'v', leaf_z: null, leaf_m: 0 },
        inner_z: [1, 2, { deep_a: 'x', deep_z: true }],
      },
      zeta: 1,
    }

    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(payloadHash(first)).toBe(payloadHash(second))
    expect(canonicalJson(first)).toBe(
      '{"alpha":{"inner_a":{"leaf_a":"v","leaf_m":0,"leaf_z":null},' +
        '"inner_z":[1,2,{"deep_a":"x","deep_z":true}]},' +
        '"middle":{"m1":"one","m2":{"m2a":1,"m2b":2}},"zeta":1}',
    )
  })

  it('is stable for an ItemSyncPayload assembled in either order', () => {
    const built: ItemSyncPayload = {
      name: 'Winter coat',
      quantity: 1,
      category: 'Clothing',
      tags: ['seasonal', 'bulky'],
      notes: 'Vacuum bagged',
      location_page_id: 'page-123',
      archived: false,
    }
    const reversed: ItemSyncPayload = {
      archived: false,
      location_page_id: 'page-123',
      notes: 'Vacuum bagged',
      tags: ['seasonal', 'bulky'],
      category: 'Clothing',
      quantity: 1,
      name: 'Winter coat',
    }
    expect(payloadHash(built)).toBe(payloadHash(reversed))
  })

  it('does not confuse key order with value order', () => {
    // Reordering keys must not change the hash, reordering an array must.
    expect(payloadHash({ tags: ['a', 'b'] })).not.toBe(payloadHash({ tags: ['b', 'a'] }))
  })
})

describe('canonicalJson, structure', () => {
  it('preserves array order and does not sort elements', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJson({ t: ['z', 'a'] })).toBe('{"t":["z","a"]}')
  })

  it('emits no whitespace', () => {
    const out = canonicalJson({ a: [1, { b: 'two' }], c: null })
    expect(out).toBe('{"a":[1,{"b":"two"}],"c":null}')
    expect(out).not.toMatch(/\s/)
  })

  it('drops undefined keys so absent and explicitly-undefined hash alike', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(payloadHash({ a: 1, b: undefined })).toBe(payloadHash({ a: 1 }))
  })

  it('drops functions and symbols from objects', () => {
    expect(canonicalJson({ a: 1, f: () => 0, s: Symbol('x') })).toBe('{"a":1}')
  })

  it('keeps array positions stable by nulling undefined elements', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]')
    expect(canonicalJson([1, undefined, 3])).not.toBe(canonicalJson([1, 3]))
  })

  it('distinguishes null from a missing key', () => {
    expect(payloadHash({ a: null })).not.toBe(payloadHash({}))
  })

  it('handles empty containers and nesting inside arrays', () => {
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson([{ b: 1, a: 2 }, []])).toBe('[{"a":2,"b":1},[]]')
  })

  it('encodes primitives the way JSON does', () => {
    expect(canonicalJson('hi')).toBe('"hi"')
    expect(canonicalJson(12)).toBe('12')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(undefined)).toBe('null')
    expect(canonicalJson('quote " and \\ and \n')).toBe(JSON.stringify('quote " and \\ and \n'))
  })

  it('encodes non-finite numbers as null, like JSON.stringify', () => {
    expect(canonicalJson({ a: NaN, b: Infinity, c: -Infinity, d: -0 })).toBe(
      '{"a":null,"b":null,"c":null,"d":0}',
    )
  })

  it('honours toJSON, so a Date is its ISO string', () => {
    const iso = '2026-07-27T12:00:00.000Z'
    expect(canonicalJson({ at: new Date(iso) })).toBe(`{"at":"${iso}"}`)
    expect(payloadHash({ at: new Date(iso) })).toBe(payloadHash({ at: iso }))
  })

  it('sorts unicode and numeric-looking keys by code unit, not by locale', () => {
    const a = { '10': 'a', '2': 'b', 'ä': 'c', 'z': 'd' }
    const b = { 'z': 'd', 'ä': 'c', '2': 'b', '10': 'a' }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    // JS integer-like keys come first in Object.keys, then the sort applies.
    expect(canonicalJson(a)).toBe('{"10":"a","2":"b","z":"d","ä":"c"}')
  })

  it('throws on a circular structure rather than looping forever', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(/circular/i)
  })

  it('allows the same object to appear twice in a non-circular graph', () => {
    const shared = { b: 1, a: 2 }
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":2,"b":1},"y":{"a":2,"b":1}}')
  })

  it('throws on BigInt rather than inventing an encoding', () => {
    // BigInt(...) rather than a literal, the tsconfig targets ES2017.
    expect(() => canonicalJson({ n: BigInt(1) })).toThrow(/BigInt/i)
  })
})

describe('payloadHash', () => {
  it('is the sha256 hex of the canonical string', () => {
    const value = { b: 2, a: 1 }
    const expected = createHash('sha256').update('{"a":1,"b":2}', 'utf8').digest('hex')
    expect(payloadHash(value)).toBe(expected)
    expect(payloadHash(value)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when any value changes', () => {
    const base: ItemSyncPayload = {
      name: 'Tent',
      quantity: 1,
      category: null,
      tags: [],
      notes: null,
      location_page_id: null,
      archived: false,
    }
    expect(payloadHash({ ...base, quantity: 2 })).not.toBe(payloadHash(base))
    expect(payloadHash({ ...base, archived: true })).not.toBe(payloadHash(base))
    expect(payloadHash({ ...base, tags: [''] })).not.toBe(payloadHash(base))
  })

  it('is deterministic across calls', () => {
    const value = { z: [1, 2, 3], a: { c: 1, b: 2 } }
    expect(payloadHash(value)).toBe(payloadHash(value))
  })
})
