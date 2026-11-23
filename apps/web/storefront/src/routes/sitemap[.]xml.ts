import { createFileRoute } from '@tanstack/react-router'
import type { StorefrontCategory } from '@weldsuite/commerce-sdk'
import { catalogueClosed } from '@/lib/access'
import { sitemapEntries, sitemapXml } from '@/lib/sitemap'
import { shopRequest } from '@/lib/server/shop'

/** The most products listed (the sitemap protocol allows 50,000 URLs per file). */
const MAX_PRODUCTS = 45_000

function flatten(categories: StorefrontCategory[]): StorefrontCategory[] {
  return categories.flatMap((category) => [category, ...flatten(category.children)])
}

/** Products, categories and the visible content pages, on the primary origin. */
export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async () => {
        const shop = await shopRequest()
        if (shop.site.preview) return new Response('Not found', { status: 404 })
        const catalogue = !catalogueClosed(shop.doc.settings.access, false)
        const products: Array<{ slug: string }> = []
        let categories: StorefrontCategory[] = []
        if (catalogue) {
          for await (const product of shop.client.products.iterate({ ...shop.options, limit: 100 })) {
            products.push({ slug: product.slug })
            if (products.length >= MAX_PRODUCTS) break
          }
          categories = flatten(await shop.client.categories.list(shop.options))
        }
        const xml = sitemapXml(
          shop.site.primaryOrigin,
          sitemapEntries({ origin: shop.site.primaryOrigin, catalogue, products, categories, pages: shop.doc.pages }),
        )
        return new Response(xml, {
          headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        })
      },
    },
  },
})
