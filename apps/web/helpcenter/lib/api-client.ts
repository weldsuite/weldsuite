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
import type {
  DeskArticleVersionLink,
  DeskPublicAnnouncement,
} from '@weldsuite/app-api-client/schemas/desk-knowledge'
import { extractHeadings, type Heading } from '@/lib/headings'
import * as helpcenter from '@/lib/server/helpcenter'
import { sanitizeArticleHtml } from '@/lib/server/sanitize-article'
import { requestDomain } from '@/lib/server/upstream'
import { isPortalEnabled } from '@/lib/server/widget-api'
import { readSessionToken, readSignedInEmail } from '@/lib/server/portal-session'

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
  /** The version's language; null = the help center's default language. */
  locale?: string | null;
  viewCount: number;
  helpfulCount: number;
  notHelpfulCount: number;
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
}

/** A language version linked from an article page. */
export type ArticleVersion = DeskArticleVersionLink

/** GET /articles/:slug: the article and every version of it the reader may open (itself included). */
export interface ArticleDetail extends Article {
  versions?: ArticleVersion[];
}

/** A status banner: published, unexpired, one the reader may see. */
export type Announcement = DeskPublicAnnouncement

/** An article the request form suggests while the reader types. */
export interface ArticleSuggestion {
  id: string;
  title: string;
  slug: string;
  excerpt?: string | null;
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
  /** Sign-in and requests: whether they are on here, and who is signed in. */
  portal: PortalState
  /** Status banners for the strip under the header. */
  announcements: Announcement[]
}

export interface PortalState {
  enabled: boolean
  /** The signed-in reader's email (from the session cookie); null when signed out. */
  email: string | null
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


/** The reader's language: the language cookie first, then Accept-Language. */
function requestLanguage(): Language {
  const headers = getRequest().headers
  return (
    createHeaderAdapter({
      cookie: headers.get('cookie') ?? '',
      acceptLanguage: headers.get('accept-language'),
    }).read?.() ?? defaultLanguage
  )
}

/**
 * Who is reading, for desk-api: the portal session token (a signed-in reader
 * sees the articles and announcements meant for them; such reads skip the edge
 * cache) and the language lists and search answer in.
 */
function currentReader(language: Language = requestLanguage()): helpcenter.Reader {
  return { session: readSessionToken(), locale: language }
}

/** Branding, navigation, locale and banners for the whole site. 404 when the host has no help center. */
export const getSite = createServerFn({ method: 'GET' }).handler(async (): Promise<SiteData> => {
  const domain = requestDomain()
  if (!domain) throw notFound()

  const language = requestLanguage()
  const reader = currentReader(language)

  // A widget-api outage only hides sign-in; the help center itself still renders.
  const [config, folders, portalEnabled, announcements] = await Promise.all([
    helpcenter.getHelpcenterConfig(domain),
    helpcenter.getFolders(domain, reader),
    isPortalEnabled(domain),
    helpcenter.getAnnouncements(domain, reader),
  ])
  if (!config) throw notFound()

  const portal: PortalState = {
    enabled: portalEnabled,
    email: portalEnabled ? readSignedInEmail() : null,
  }

  return { domain, config, folders, language, portal, announcements }
})

/** The six newest articles for the landing page. */
export const getRecentArticles = createServerFn({ method: 'GET' }).handler(async () => {
  const recent = await helpcenter.getArticles(requestDomain(), { pageSize: '6' }, currentReader())
  return recent.data.map(summary)
})

/** One article with its HTML sanitized, its outline extracted and its language versions. */
export const getArticlePage = createServerFn({ method: 'GET' })
  .validator((input: { slug: string }) => input)
  .handler(async ({ data }): Promise<{ article: ArticleDetail; headings: Heading[] }> => {
    const article = await helpcenter.getArticle(requestDomain(), data.slug, currentReader())
    if (!article) throw notFound()

    const content = sanitizeArticleHtml(article.content || '')
    return {
      article: { ...article, content, versions: article.versions ?? [] },
      headings: extractHeadings(content),
    }
  })

/** A folder and one page of its articles. */
export const getCategoryPage = createServerFn({ method: 'GET' })
  .validator((input: { id: string; page?: number }) => input)
  .handler(async ({ data }) => {
    const domain = requestDomain()
    const reader = currentReader()
    const [folders, articles] = await Promise.all([
      helpcenter.getFolders(domain, reader),
      helpcenter.getArticles(domain, { folderId: data.id, page: String(data.page ?? 1) }, reader),
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
    return summaries(await helpcenter.searchArticles(requestDomain(), query, String(data.page ?? 1), currentReader()))
  })

/** Shortest text worth searching for while a reader types. */
const SUGGEST_MIN_LENGTH = 3
const SUGGEST_MAX_LENGTH = 200
const SUGGEST_LIMIT = 3

/**
 * Up to three articles the reader may see that match what they are typing
 * into the request form (title and description), in their language.
 */
export const suggestArticles = createServerFn({ method: 'GET' })
  .validator((input: { q?: string }) => ({ q: typeof input?.q === 'string' ? input.q : '' }))
  .handler(async ({ data }): Promise<ArticleSuggestion[]> => {
    const query = data.q.trim().slice(0, SUGGEST_MAX_LENGTH)
    if (query.length < SUGGEST_MIN_LENGTH) return []
    const domain = requestDomain()
    if (!domain) return []
    const page = await helpcenter.searchArticles(domain, query, '1', currentReader(), String(SUGGEST_LIMIT), 'any')
    return page.data.slice(0, SUGGEST_LIMIT).map(({ id, title, slug, excerpt }) => ({ id, title, slug, excerpt }))
  })
