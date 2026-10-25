/**
 * Help Center data for routes.
 *
 * Each export below is a TanStack Start server function: it runs in the
 * Worker, and a call from the browser (client-side navigation) becomes an RPC
 * to this app's own origin. The tenant always comes from the request's host
 * (`requestDomain`), never from the caller, so a page can only read the help
 * center it is served on.
 */
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { createHeaderAdapter } from '@weldsuite/i18n/adapters/header'
import { defaultLanguage, type Language } from '@weldsuite/i18n/locales'
import { extractHeadings, type Heading } from '@/lib/headings'
import * as helpcenter from '@/lib/server/helpcenter'
import { sanitizeArticleHtml } from '@/lib/server/sanitize-article'
import { requestDomain } from '@/lib/server/upstream'

// ============================================================================
// Types (shapes of desk-api's /public/helpcenter responses)
// ============================================================================

export interface HelpcenterConfig {
  siteName?: string;
  logo?: string;
  logoDark?: string;
  favicon?: string;
  primaryColor?: string;
  accentColor?: string;
  heroTitle?: string;
  heroSubtitle?: string;
  showSearch?: number;
  showCategories?: number;
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  footerText?: string;
  socialLinks?: Record<string, string>;
  customCss?: string;
  googleAnalyticsId?: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId?: string | null;
  sortOrder: number;
  icon?: string | null;
  description?: string | null;
  articleCount?: number;
}

export interface Article {
  id: string;
  title: string;
  slug: string;
  content?: string;
  excerpt?: string;
  folderId?: string;
  viewCount: number;
  helpfulCount: number;
  notHelpfulCount: number;
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface PaginatedArticles {
  data: Article[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasMore: boolean;
  };
}

export interface SiteData {
  domain: string
  config: HelpcenterConfig
  folders: Folder[]
  /** Request locale: cookie first, then Accept-Language. */
  language: Language
}

// ============================================================================
// Server functions
// ============================================================================

/**
 * Lists only need what a link shows. Dropping `content` keeps raw (unsanitized)
 * article HTML out of the page's serialized loader data.
 */
const summary = ({ content: _content, ...rest }: Article): Article => rest

const summaries = (page: PaginatedArticles): PaginatedArticles => ({
  ...page,
  data: page.data.map(summary),
})

/** Branding, navigation and locale for the whole site. 404 when the host has no help center. */
export const getSite = createServerFn({ method: 'GET' }).handler(async (): Promise<SiteData> => {
  const domain = requestDomain()
  if (!domain) throw notFound()

  const [config, folders] = await Promise.all([
    helpcenter.getHelpcenterConfig(domain),
    helpcenter.getFolders(domain),
  ])
  if (!config) throw notFound()

  const headers = getRequest().headers
  const language =
    createHeaderAdapter({
      cookie: headers.get('cookie') ?? '',
      acceptLanguage: headers.get('accept-language'),
    }).read?.() ?? defaultLanguage

  return { domain, config, folders, language }
})

/** The six newest articles for the landing page. */
export const getRecentArticles = createServerFn({ method: 'GET' }).handler(async () => {
  const recent = await helpcenter.getArticles(requestDomain(), { pageSize: '6' })
  return recent.data.map(summary)
})

/** One article with its HTML sanitized and its outline extracted. */
export const getArticlePage = createServerFn({ method: 'GET' })
  .validator((input: { slug: string }) => input)
  .handler(async ({ data }): Promise<{ article: Article; headings: Heading[] }> => {
    const article = await helpcenter.getArticle(requestDomain(), data.slug)
    if (!article) throw notFound()

    const content = sanitizeArticleHtml(article.content || '')
    return { article: { ...article, content }, headings: extractHeadings(content) }
  })

/** A folder and one page of its articles. */
export const getCategoryPage = createServerFn({ method: 'GET' })
  .validator((input: { id: string; page?: number }) => input)
  .handler(async ({ data }) => {
    const domain = requestDomain()
    const [folders, articles] = await Promise.all([
      helpcenter.getFolders(domain),
      helpcenter.getArticles(domain, { folderId: data.id, page: String(data.page ?? 1) }),
    ])

    const folder = folders.find((f) => f.id === data.id)
    if (!folder) throw notFound()

    return { folder, articles: summaries(articles) }
  })

/** Full-text search; `null` when there is no query. */
export const searchArticles = createServerFn({ method: 'GET' })
  .validator((input: { q?: string; page?: number }) => input)
  .handler(async ({ data }) => {
    const query = data.q?.trim()
    if (!query) return null
    return summaries(await helpcenter.searchArticles(requestDomain(), query, String(data.page ?? 1)))
  })
