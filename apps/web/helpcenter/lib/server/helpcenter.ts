import { getJson } from '@/lib/server/upstream'
import type {
  Announcement,
  ArticleDetail,
  Folder,
  HelpcenterConfig,
  PaginatedArticles,
} from '@/lib/api-client'

/**
 * Typed reads of desk-api's public help-center endpoints. Server-only: call
 * these from server functions and server routes, never from components.
 *
 * Content is cached at the edge for 60 s (what ISR did). Branding is always
 * live, so a settings change shows up right away.
 *
 * `reader` says who is reading: the signed-in reader's portal session token
 * (desk-api applies article audiences with it; a read with a session is never
 * cached) and the reader's language (lists and search answer the version in
 * it; it is a query parameter, so the cache keeps one copy per language).
 * The sitemap reads without a reader: public originals only.
 */
const CONTENT_TTL = 60

export interface Reader {
  session?: string
  locale?: string
}

const emptyPage = (): PaginatedArticles => ({
  data: [],
  pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false },
})

const unwrap = <T>(json: { data?: T } | T): T =>
  (json as { data?: T }).data ?? (json as T)

export async function getHelpcenterConfig(domain: string): Promise<HelpcenterConfig | null> {
  try {
    return unwrap(await getJson<{ data: HelpcenterConfig }>('/config', domain, { ttl: 0 }))
  } catch {
    return null
  }
}

export async function getFolders(domain: string, reader: Reader = {}): Promise<Folder[]> {
  try {
    return unwrap(
      // Counts per folder depend on who reads (audiences), not on the language.
      await getJson<{ data: Folder[] }>('/folders', domain, {
        ttl: CONTENT_TTL,
        session: reader.session,
      }),
    )
  } catch {
    return []
  }
}

export async function getArticles(
  domain: string,
  opts?: { folderId?: string; search?: string; page?: string; pageSize?: string },
  reader: Reader = {},
): Promise<PaginatedArticles> {
  try {
    return await getJson<PaginatedArticles>('/articles', domain, {
      params: { ...opts, locale: reader.locale },
      ttl: CONTENT_TTL,
      session: reader.session,
    })
  } catch {
    return emptyPage()
  }
}

export async function getArticle(domain: string, slug: string, reader: Reader = {}): Promise<ArticleDetail | null> {
  try {
    return unwrap(
      await getJson<{ data: ArticleDetail }>(`/articles/${encodeURIComponent(slug)}`, domain, {
        params: { locale: reader.locale },
        ttl: CONTENT_TTL,
        session: reader.session,
      }),
    )
  } catch {
    return null
  }
}

export async function searchArticles(
  domain: string,
  query: string,
  page = '1',
  reader: Reader = {},
  pageSize?: string,
): Promise<PaginatedArticles> {
  try {
    return await getJson<PaginatedArticles>('/search', domain, {
      params: { q: query, page, pageSize, locale: reader.locale },
      ttl: CONTENT_TTL,
      session: reader.session,
    })
  } catch {
    return emptyPage()
  }
}

/** Published, unexpired announcements the reader may see. A failure hides the banners, nothing else. */
export async function getAnnouncements(domain: string, reader: Reader = {}): Promise<Announcement[]> {
  try {
    return unwrap(
      await getJson<{ data: Announcement[] }>('/announcements', domain, {
        ttl: CONTENT_TTL,
        session: reader.session,
      }),
    )
  } catch {
    return []
  }
}
