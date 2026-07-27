import type { NotionApi, NotionPage } from '@/lib/notion/api'

/**
 * In-memory Notion. Mimics the parts of the real API the sync workers depend
 * on: server assigned ids, server set last_edited_time, archived flag, and a
 * last_edited_time filter on query.
 *
 * Time is virtual so the conformance suite can order events precisely without
 * sleeping, and so "the app row is newer than the page" is a fact the test sets
 * rather than a race it hopes for.
 */
export class FakeNotion implements NotionApi {
  pages = new Map<string, NotionPage>()
  calls: { op: string; pageId?: string }[] = []

  private seq = 0
  /**
   * Notion's clock and Postgres's clock are genuinely separate in production,
   * and the conflict rule in 7.5 step 4 compares one against the other. Tests
   * must therefore seed this from the database's now(), or "which side is
   * newer" is decided by clock skew instead of by the test.
   */
  private clock = Date.now()

  /** Queue of errors to throw on the next N calls, for retry and 429 tests. */
  private failures: (Error | null)[] = []

  now(): string { return new Date(this.clock).toISOString() }
  advance(ms: number) { this.clock += ms }
  /** Align this fake with the database clock. */
  setClock(iso: string | Date) { this.clock = new Date(iso).getTime() }

  failNext(err: Error) { this.failures.push(err) }

  private maybeFail() {
    const next = this.failures.shift()
    if (next) throw next
  }

  private touch(): string {
    // Every write advances the clock by a second, matching Notion's practical
    // one second granularity on last_edited_time.
    this.clock += 1000
    return this.now()
  }

  async createPage({ dataSourceId, body }: {
    dataSourceId: string; body: Record<string, unknown>
  }): Promise<NotionPage> {
    this.calls.push({ op: 'create' })
    this.maybeFail()
    const id = `page-${++this.seq}`
    const page: NotionPage = {
      id,
      last_edited_time: this.touch(),
      archived: body.archived === true,
      properties: (body.properties as Record<string, unknown>) ?? {},
    }
    Object.defineProperty(page, '__dataSource', { value: dataSourceId, enumerable: false })
    this.pages.set(id, page)
    return structuredClone(page)
  }

  async updatePage({ pageId, body }: {
    pageId: string; body: Record<string, unknown>
  }): Promise<NotionPage> {
    this.calls.push({ op: 'update', pageId })
    this.maybeFail()
    const existing = this.pages.get(pageId)
    if (!existing) {
      const err = new Error('Could not find page') as Error & { status: number }
      err.status = 404
      throw err
    }
    const next: NotionPage = {
      ...existing,
      last_edited_time: this.touch(),
      archived: body.archived === true ? true : body.archived === false ? false : existing.archived,
      properties: body.properties
        ? { ...existing.properties, ...(body.properties as Record<string, unknown>) }
        : existing.properties,
    }
    this.pages.set(pageId, next)
    return structuredClone(next)
  }

  async retrievePage(pageId: string): Promise<NotionPage> {
    this.calls.push({ op: 'retrieve', pageId })
    this.maybeFail()
    const page = this.pages.get(pageId)
    if (!page) {
      const err = new Error('Could not find page') as Error & { status: number }
      err.status = 404
      throw err
    }
    return structuredClone(page)
  }

  async queryDataSource({ dataSourceId, editedAfter, cursor, pageSize = 100 }: {
    dataSourceId: string; editedAfter?: string | null; cursor?: string | null; pageSize?: number
  }) {
    this.calls.push({ op: 'query' })
    this.maybeFail()
    const all = [...this.pages.values()]
      .filter((p) => {
        const ds = (p as unknown as { __dataSource?: string }).__dataSource
        return ds === undefined || ds === dataSourceId
      })
      .filter((p) => !editedAfter || new Date(p.last_edited_time) >= new Date(editedAfter))
      .sort((a, b) => a.id.localeCompare(b.id))

    const start = cursor ? all.findIndex((p) => p.id === cursor) : 0
    const slice = all.slice(start, start + pageSize)
    const nextIndex = start + pageSize
    return {
      pages: slice.map((p) => structuredClone(p)),
      nextCursor: nextIndex < all.length ? all[nextIndex].id : null,
    }
  }

  /** Simulate a human editing a property in the Notion UI. */
  humanEdit(pageId: string, properties: Record<string, unknown>) {
    const page = this.pages.get(pageId)
    if (!page) throw new Error(`no page ${pageId}`)
    this.pages.set(pageId, {
      ...page,
      last_edited_time: this.touch(),
      properties: { ...page.properties, ...properties },
    })
  }

  /** Simulate a human archiving a row. */
  humanArchive(pageId: string) {
    const page = this.pages.get(pageId)
    if (!page) throw new Error(`no page ${pageId}`)
    this.pages.set(pageId, { ...page, archived: true, last_edited_time: this.touch() })
  }
}

export function rateLimitError(retryAfter = 1): Error & { status: number; headers: Record<string, string> } {
  const err = new Error('Rate limited') as Error & { status: number; headers: Record<string, string> }
  err.status = 429
  err.headers = { 'retry-after': String(retryAfter) }
  return err
}

export function validationError(message = 'Invalid property'): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = 400
  return err
}
