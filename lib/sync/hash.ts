import { createHash } from 'node:crypto'

/**
 * Deterministic JSON plus its sha256, the echo-suppression primitive from
 * section 7.4 step 3 and 7.5 step 3.
 *
 * `JSON.stringify` is not usable here: its object key order follows insertion
 * order, so two payloads that are semantically identical hash differently and
 * every sync becomes a false positive. Everything in this module exists to make
 * the byte output a pure function of the *value*, never of how it was built.
 *
 * Rules:
 * - Object keys are sorted, recursively, at every depth.
 * - Array order is meaningful and preserved.
 * - `undefined` (and functions and symbols) are dropped from objects, and
 *   become `null` inside arrays, matching `JSON.stringify` so an absent key and
 *   an explicitly-undefined key hash the same.
 * - No whitespace anywhere.
 */

/** Locale-independent UTF-16 code unit order. Never use localeCompare here. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function encode(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      // NaN and +/-Infinity are not representable in JSON. Match JSON.stringify.
      return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    case 'string':
      return JSON.stringify(value)
    case 'bigint':
      throw new TypeError('canonicalJson cannot serialize a BigInt')
  }

  const obj = value as Record<string, unknown>

  // Honour toJSON before anything else, so Date serializes as its ISO string.
  const toJSON = (obj as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') {
    return encode((toJSON as (key?: string) => unknown).call(obj), seen)
  }

  if (seen.has(obj)) {
    throw new TypeError('canonicalJson cannot serialize a circular structure')
  }
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      let out = '['
      for (let i = 0; i < obj.length; i++) {
        if (i > 0) out += ','
        // A hole or an undefined element must not shift the remaining elements.
        out += encode(obj[i], seen) ?? 'null'
      }
      return out + ']'
    }

    const keys = Object.keys(obj).sort(compareKeys)
    let out = '{'
    let first = true
    for (const key of keys) {
      const encoded = encode(obj[key], seen)
      if (encoded === undefined) continue
      if (!first) out += ','
      first = false
      out += `${JSON.stringify(key)}:${encoded}`
    }
    return out + '}'
  } finally {
    seen.delete(obj)
  }
}

/**
 * Serialize `value` to JSON whose bytes depend only on the value, not on key
 * insertion order at any nesting depth.
 *
 * A top-level `undefined` encodes as `null` rather than returning `undefined`,
 * so the return type is always a string and always hashable.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>()) ?? 'null'
}

/** sha256 hex digest of `canonicalJson(value)`. This is `last_pushed_hash`. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}
