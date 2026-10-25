import { createFileRoute } from '@tanstack/react-router'
import { getArticles, getFolders } from '@/lib/server/helpcenter'
import { cached } from '@/lib/server/cache'
import { requestDomain } from '@/lib/server/upstream'
import type { Article } from '@/lib/api-client'
import { sitemapXml, type SitemapEntry } from '@/lib/sitemap-xml'

// Sitemaps change slowly; rebuild hourly rather than on the 60 s content TTL.
const SITEMAP_TTL = 3600

async function buildSitemap(domain: string): Promise<Response> {
  const baseUrl = `https://${domain}`
  const folders = await getFolders(domain)

  // Walk every page so workspaces with >1 page of articles aren't truncated.
  const articles: Article[] = []
  for (let page = 1; page <= 100; page++) {
    const res = await getArticles(domain, { page: String(page), pageSize: '50' })
    articles.push(...res.data)
    if (!res.pagination.hasMore) break
  }

  const entries: SitemapEntry[] = [
    { url: baseUrl, lastModified: new Date(), changeFrequency: 'daily', priority: 1 },
  ]

  for (const folder of folders) {
    entries.push({
      url: `${baseUrl}/category/${folder.id}`,
      changeFrequency: 'weekly',
      priority: 0.8,
    })
  }

  for (const article of articles) {
    entries.push({
      url: `${baseUrl}/articles/${article.slug}`,
      lastModified: article.updatedAt ? new Date(article.updatedAt) : undefined,
      changeFrequency: 'weekly',
      priority: 0.6,
    })
  }

  return new Response(sitemapXml(entries), {
    headers: { 'Content-Type': 'application/xml' },
  })
}

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const domain = requestDomain(request)
        if (!domain) return new Response('Not found', { status: 404 })
        return cached(`https://${domain}/sitemap.xml`, SITEMAP_TTL, () => buildSitemap(domain))
      },
    },
  },
})
