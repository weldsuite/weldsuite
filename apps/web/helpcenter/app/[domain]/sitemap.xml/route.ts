import type { MetadataRoute } from 'next';
import { getArticles, getFolders, type Article } from '@/lib/api-client';
import { sitemapXml } from '@/lib/sitemap-xml';

// Sitemaps change slowly; refresh hourly rather than on the 60s content TTL.
export const revalidate = 3600;

// A route handler rather than sitemap.ts: Next.js never passes `params` to a
// sitemap or robots metadata route (16.3 calls it with no arguments), and the
// domain only exists as the [domain] segment the proxy rewrites each host to.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ domain: string }> },
) {
  const { domain } = await params;
  const baseUrl = `https://${domain}`;

  const folders = await getFolders(domain);

  // Walk every page so workspaces with >1 page of articles aren't truncated.
  const articles: Article[] = [];
  for (let page = 1; page <= 100; page++) {
    const res = await getArticles(domain, { page: String(page), pageSize: '50' });
    articles.push(...res.data);
    if (!res.pagination.hasMore) break;
  }

  const entries: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: new Date(), changeFrequency: 'daily', priority: 1 },
  ];

  for (const folder of folders) {
    entries.push({
      url: `${baseUrl}/category/${folder.id}`,
      changeFrequency: 'weekly',
      priority: 0.8,
    });
  }

  for (const article of articles) {
    entries.push({
      url: `${baseUrl}/articles/${article.slug}`,
      lastModified: article.updatedAt ? new Date(article.updatedAt) : undefined,
      changeFrequency: 'weekly',
      priority: 0.6,
    });
  }

  return new Response(sitemapXml(entries), {
    headers: { 'Content-Type': 'application/xml' },
  });
}
