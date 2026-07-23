import { MetadataRoute } from 'next';
import { getWebsiteByDomain } from '@/lib/api-client';

interface RobotsParams {
  domain: string;
}

/**
 * Generate robots.txt for a specific domain
 * https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots
 */
export default async function robots(
  { params }: { params: Promise<RobotsParams> }
): Promise<MetadataRoute.Robots> {
  const { domain } = await params;

  // Fetch website data
  const website = await getWebsiteByDomain(domain);

  if (!website || !website.isPublished) {
    // Block all crawlers if website is not published
    return {
      rules: {
        userAgent: '*',
        disallow: '/',
      },
    };
  }

  const baseUrl = website.publishedUrl || `https://${domain}`;

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/admin/'],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
