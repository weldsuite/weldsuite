import { getWebsiteByDomain } from '@/lib/api-client';

interface RobotsParams {
  domain: string;
}

const textResponse = (lines: string[]) =>
  new Response([...lines, ''].join('\n'), { headers: { 'Content-Type': 'text/plain' } });

/**
 * Generate robots.txt for a specific domain.
 *
 * A route handler rather than robots.ts, for the same reason as sitemap.xml:
 * Next.js doesn't pass `params` to metadata routes.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<RobotsParams> }
) {
  const { domain } = await params;

  // Fetch website data
  const website = await getWebsiteByDomain(domain);

  if (!website?.isPublished) {
    // Block all crawlers if website is not published
    return textResponse(['User-Agent: *', 'Disallow: /']);
  }

  const baseUrl = website.publishedUrl || `https://${domain}`;

  return textResponse([
    'User-Agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /admin/',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
  ]);
}
