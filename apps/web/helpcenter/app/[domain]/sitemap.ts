import type { MetadataRoute } from 'next';
import { getArticles, getFolders, type Article } from '@/lib/api-client';

// Sitemaps change slowly; refresh hourly rather than on the 60s content TTL.
export const revalidate = 3600;

export default async function sitemap({
  params,
}: {
  params: Promise<{ domain: string }>;
}): Promise<MetadataRoute.Sitemap> {
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

  return entries;
}
