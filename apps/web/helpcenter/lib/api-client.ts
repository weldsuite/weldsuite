/**
 * Help Center API Client
 *
 * Server-side data fetching with ISR (60s revalidation).
 * All endpoints call app-api's public helpcenter routes (/public/helpcenter/*),
 * resolved to a tenant by the `?domain=` query param.
 */

const API_URL = process.env.HELPCENTER_API_URL || 'http://localhost:8789';

async function fetchApi<T>(
  path: string,
  domain: string,
  params?: Record<string, string>,
  // Seconds to cache. 0 = always live (used for branding/config so settings
  // changes show up immediately instead of after the ISR window).
  revalidate = 60,
): Promise<T> {
  const url = new URL(`/public/helpcenter${path}`, API_URL);
  url.searchParams.set('domain', domain);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    cache: revalidate === 0 ? 'no-store' : undefined,
    next: revalidate === 0 ? undefined : { revalidate },
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }

  const json = await res.json();
  return json.data ?? json;
}

// ============================================================================
// Config
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

export async function getHelpcenterConfig(domain: string): Promise<HelpcenterConfig | null> {
  try {
    // Always live: branding (site name, title, colors, logo) must reflect a
    // settings change right away, not after the ISR window.
    return await fetchApi<HelpcenterConfig>('/config', domain, undefined, 0);
  } catch {
    return null;
  }
}

// ============================================================================
// Folders
// ============================================================================

export interface Folder {
  id: string;
  name: string;
  parentId?: string | null;
  sortOrder: number;
  icon?: string | null;
  description?: string | null;
  articleCount?: number;
}

export async function getFolders(domain: string): Promise<Folder[]> {
  try {
    return await fetchApi<Folder[]>('/folders', domain);
  } catch {
    return [];
  }
}

// ============================================================================
// Articles
// ============================================================================

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

export async function getArticles(
  domain: string,
  opts?: { folderId?: string; search?: string; page?: string; pageSize?: string }
): Promise<PaginatedArticles> {
  try {
    const url = new URL(`/public/helpcenter/articles`, API_URL);
    url.searchParams.set('domain', domain);
    if (opts?.folderId) url.searchParams.set('folderId', opts.folderId);
    if (opts?.search) url.searchParams.set('search', opts.search);
    if (opts?.page) url.searchParams.set('page', opts.page);
    if (opts?.pageSize) url.searchParams.set('pageSize', opts.pageSize);

    const res = await fetch(url.toString(), { next: { revalidate: 60 } });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch {
    return { data: [], pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false } };
  }
}

export async function getArticle(domain: string, slug: string): Promise<Article | null> {
  try {
    return await fetchApi<Article>(`/articles/${slug}`, domain);
  } catch {
    return null;
  }
}

// ============================================================================
// Search
// ============================================================================

export async function searchArticles(
  domain: string,
  query: string,
  page = '1'
): Promise<PaginatedArticles> {
  try {
    const url = new URL(`/public/helpcenter/search`, API_URL);
    url.searchParams.set('domain', domain);
    url.searchParams.set('q', query);
    url.searchParams.set('page', page);

    const res = await fetch(url.toString(), { next: { revalidate: 60 } });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch {
    return { data: [], pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasMore: false } };
  }
}

// Feedback submission is handled by the app/api/feedback route handler (keeps
// the API base server-side); see components/ArticleFeedback.tsx.
