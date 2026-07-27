import 'server-only'
import { notionClient } from './client'
import { notionLimiter } from './limiter'

/**
 * The only Notion surface the sync workers touch.
 *
 * Narrow on purpose: the conformance suite in section 11 implements this
 * interface with an in-memory fake, so the workers under test are the real ones
 * and only the network is swapped out.
 */
export interface NotionApi {
  createPage(input: {
    dataSourceId: string
    body: Record<string, unknown>
  }): Promise<NotionPage>

  updatePage(input: {
    pageId: string
    body: Record<string, unknown>
  }): Promise<NotionPage>

  retrievePage(pageId: string): Promise<NotionPage>

  /** Section 7.6: page through a data source, optionally filtered by edit time. */
  queryDataSource(input: {
    dataSourceId: string
    editedAfter?: string | null
    cursor?: string | null
    pageSize?: number
  }): Promise<{ pages: NotionPage[]; nextCursor: string | null }>
}

export type NotionPage = {
  id: string
  last_edited_time: string
  archived?: boolean
  in_trash?: boolean
  properties: Record<string, unknown>
}

/** Production implementation. Every call goes through the token bucket, section 7.7. */
export function liveNotionApi(): NotionApi {
  const notion = notionClient()

  return {
    createPage: ({ dataSourceId, body }) =>
      notionLimiter.run(async () => {
        const res = await notion.pages.create({
          parent: { type: 'data_source_id', data_source_id: dataSourceId },
          ...body,
        } as never)
        return res as unknown as NotionPage
      }),

    updatePage: ({ pageId, body }) =>
      notionLimiter.run(async () => {
        const res = await notion.pages.update({ page_id: pageId, ...body } as never)
        return res as unknown as NotionPage
      }),

    retrievePage: (pageId) =>
      notionLimiter.run(async () => {
        const res = await notion.pages.retrieve({ page_id: pageId })
        return res as unknown as NotionPage
      }),

    queryDataSource: ({ dataSourceId, editedAfter, cursor, pageSize = 100 }) =>
      notionLimiter.run(async () => {
        const res = await notion.dataSources.query({
          data_source_id: dataSourceId,
          page_size: pageSize,
          ...(cursor ? { start_cursor: cursor } : {}),
          ...(editedAfter
            ? { filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: editedAfter } } }
            : {}),
        } as never)
        const r = res as unknown as { results: NotionPage[]; next_cursor: string | null }
        return { pages: r.results, nextCursor: r.next_cursor }
      }),
  }
}
