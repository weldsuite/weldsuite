import { MetadataRoute } from 'next';
import { getWebsiteByDomain } from '@/lib/api-client';
import { sitemapXml } from '@/lib/sitemap-xml';

interface SitemapParams {
  domain: string;
}

const xmlResponse = (entries: MetadataRoute.Sitemap) =>
  new Response(sitemapXml(entries), { headers: { 'Content-Type': 'application/xml' } });

/**
 * Generate sitemap for a specific domain.
 *
 * A route handler rather than sitemap.ts: Next.js never passes `params` to a
 * sitemap or robots metadata route (it calls them with no arguments), and the
 * domain only exists as the [domain] segment the middleware rewrites to.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<SitemapParams> }
) {
  const { domain } = await params;

  // Fetch website data
  const website = await getWebsiteByDomain(domain);

  if (!website?.isPublished) {
    return xmlResponse([]);
  }

  const baseUrl = website.publishedUrl || `https://${domain}`;
  const pages = (website.websitePages || []) as any[];

  // Create sitemap entries for all published pages
  const pageEntries: MetadataRoute.Sitemap = pages
    .filter((page: any) => page.slug)
    .map((page: any) => ({
      url: `${baseUrl}${page.slug}`,
      lastModified: website.updatedAt ? new Date(website.updatedAt) : new Date(),
      changeFrequency: 'weekly' as const,
      priority: page.isHomePage ? 1.0 : 0.8,
    }));

  // Add home page if not already included
  const hasHomePage = pages.some((page: any) => page.isHomePage);
  if (!hasHomePage) {
    pageEntries.unshift({
      url: baseUrl,
      lastModified: website.updatedAt ? new Date(website.updatedAt) : new Date(),
      changeFrequency: 'daily' as const,
      priority: 1.0,
    });
  }

  return xmlResponse(pageEntries);
}
