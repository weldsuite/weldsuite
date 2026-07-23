import { MetadataRoute } from 'next';
import { getWebsiteByDomain } from '@/lib/api-client';

interface SitemapParams {
  domain: string;
}

/**
 * Generate sitemap for a specific domain
 * https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap
 */
export default async function sitemap(
  { params }: { params: Promise<SitemapParams> }
): Promise<MetadataRoute.Sitemap> {
  const { domain } = await params;

  // Fetch website data
  const website = await getWebsiteByDomain(domain);

  if (!website || !website.isPublished) {
    return [];
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

  return pageEntries;
}
