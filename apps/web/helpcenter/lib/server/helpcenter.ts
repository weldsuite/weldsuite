import { getJson } from '@/lib/server/upstream'
import type { Article, Folder, HelpcenterConfig, PaginatedArticles } from '@/lib/api-client'

/**
 * Typed reads of desk-api's public help-center endpoints. Server-only: call
 * these from server functions and server routes, never from components.
 *
 * Content is cached at the edge for 60 s (what ISR did). Branding is always
 * live, so a settings change shows up right away.
 */
const CONTENT_TTL = 60

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

export async function getFolders(domain: string): Promise<Folder[]> {
  try {
    return unwrap(await getJson<{ data: Folder[] }>('/folders', domain, { ttl: CONTENT_TTL }))
  } catch {
    return []
  }
}

export async function getArticles(
  domain: string,
  opts?: { folderId?: string; search?: string; page?: string; pageSize?: string },
): Promise<PaginatedArticles> {
  try {
    return await getJson<PaginatedArticles>('/articles', domain, { params: opts, ttl: CONTENT_TTL })
  } catch {
    return emptyPage()
  }
}

export async function getArticle(domain: string, slug: string): Promise<Article | null> {
  try {
    return unwrap(
      await getJson<{ data: Article }>(`/articles/${encodeURIComponent(slug)}`, domain, { ttl: CONTENT_TTL }),
    )
  } catch {
    return null
  }
}

export async function searchArticles(domain: string, query: string, page = '1'): Promise<PaginatedArticles> {
  try {
    return await getJson<PaginatedArticles>('/search', domain, {
      params: { q: query, page },
      ttl: CONTENT_TTL,
    })
  } catch {
    return emptyPage()
  }
}
