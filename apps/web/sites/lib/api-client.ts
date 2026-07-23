"use server";

/**
 * Server-side API client for fetching website data from the WeldSuite Sites API
 * All functions run on the server only (Next.js Server Actions)
 */

// Use internal URL for server-side requests, external URL for client-side
const API_BASE_URL = process.env.SITES_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

export interface Website {
  id: string;
  name: string;
  slug: string;
  description?: string;
  storeId?: string;
  logo?: string;
  favicon?: string;
  // Individual theme properties (not nested)
  primaryColor?: string;
  secondaryColor?: string;
  fontFamily?: string;
  seoTitle?: string;
  seoDescription?: string;
  seoKeywords?: string;
  ogImage?: string;
  // Relational pages (from WebsitePages navigation property)
  websitePages?: WebsitePage[];
  customCss?: string;
  customJs?: string;
  customHead?: string;
  googleAnalytics?: string;
  facebookPixel?: string;
  analytics?: any;
  isPublished: boolean;
  publishedUrl?: string;
  status: string;
  publishedAt?: string;
  settings?: any;
  metadata?: any;
  createdAt: string;
  updatedAt: string;
}

export interface WebsitePage {
  id: string;
  name: string;
  title: string;
  slug: string;
  isHomePage?: boolean;
  pageType?: string;
  seoTitle?: string;
  seoDescription?: string;
  // Sections grouped by zone (loaded from API)
  sections?: any[];
  headerSections?: any[];
  footerSections?: any[];
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: string[];
}

/**
 * Fetch website by domain (Server Action)
 * This uses the new WeldSuite Sites API endpoint
 */
export async function getWebsiteByDomain(domain: string): Promise<Website | null> {
  try {
    console.log(`[Server] Fetching website for domain: ${domain} from ${API_BASE_URL}`);

    const response = await fetch(
      `${API_BASE_URL}/api/sites/website?domain=${encodeURIComponent(domain)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        next: { revalidate: 60 }, // Cache for 60 seconds (ISR)
      }
    );

    if (!response.ok) {
      console.error(`[Server] API returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const result: ApiResponse<Website> = await response.json();

    if (result.success && result.data) {
      console.log(`[Server] Successfully fetched website: ${result.data.name}`);
      return result.data;
    }

    console.warn(`[Server] API returned unsuccessful response:`, result.message);
    return null;
  } catch (error) {
    console.error('[Server] Error fetching website by domain:', error);
    return null;
  }
}

/**
 * Resolve domain to workspace (Server Action)
 */
export async function resolveDomain(domain: string): Promise<any> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/sites/resolve-domain?domain=${encodeURIComponent(domain)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      return null;
    }

    const result: ApiResponse<any> = await response.json();
    return result.success ? result.data : null;
  } catch (error) {
    console.error('[Server] Error resolving domain:', error);
    return null;
  }
}

/**
 * Track page view (Server Action - fire and forget)
 */
export async function trackPageView(websiteId: string, page: string): Promise<void> {
  try {
    // This would need to be implemented in the Sites API if needed
    // For now, just log it
    console.log(`[Server] Tracking page view: ${websiteId} - ${page}`);
  } catch (error) {
    // Silently fail analytics
    console.debug('[Server] Failed to track page view:', error);
  }
}

/**
 * Fetch products for a domain (Server Action)
 */
export async function getProducts(
  domain: string,
  ids?: string[],
  limit?: number,
  featured?: boolean,
  categoryId?: string
): Promise<any[] | null> {
  try {
    const params = new URLSearchParams({ domain });
    if (ids && ids.length > 0) params.set('ids', ids.join(','));
    if (limit) params.set('limit', limit.toString());
    if (featured !== undefined) params.set('featured', featured.toString());
    if (categoryId) params.set('categoryId', categoryId);

    console.log(`[Server] Fetching products for domain: ${domain} with params:`, Object.fromEntries(params));

    const response = await fetch(
      `${API_BASE_URL}/api/sites/products?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        next: { revalidate: 300 }, // Cache for 5 minutes
      }
    );

    if (!response.ok) {
      console.error(`[Server] Products API returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const result: ApiResponse<any[]> = await response.json();

    if (result.success && result.data) {
      console.log(`[Server] Successfully fetched ${result.data.length} products`);
      return result.data;
    }

    return null;
  } catch (error) {
    console.error('[Server] Error fetching products:', error);
    return null;
  }
}

/**
 * Fetch collections for a domain (Server Action)
 */
export async function getCollections(
  domain: string,
  ids?: string[],
  limit?: number
): Promise<any[] | null> {
  try {
    const params = new URLSearchParams({ domain });
    if (ids && ids.length > 0) params.set('ids', ids.join(','));
    if (limit) params.set('limit', limit.toString());

    console.log(`[Server] Fetching collections for domain: ${domain} with params:`, Object.fromEntries(params));

    const response = await fetch(
      `${API_BASE_URL}/api/sites/collections?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        next: { revalidate: 300 }, // Cache for 5 minutes
      }
    );

    if (!response.ok) {
      console.error(`[Server] Collections API returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const result: ApiResponse<any[]> = await response.json();

    if (result.success && result.data) {
      console.log(`[Server] Successfully fetched ${result.data.length} collections`);
      return result.data;
    }

    return null;
  } catch (error) {
    console.error('[Server] Error fetching collections:', error);
    return null;
  }
}