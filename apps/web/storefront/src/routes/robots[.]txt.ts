import { createFileRoute } from '@tanstack/react-router'
import { robotsTxt } from '@/lib/sitemap'
import { shopRequest } from '@/lib/server/shop'

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: async () => {
        const shop = await shopRequest()
        return new Response(robotsTxt(shop.site.primaryOrigin, shop.site.preview), {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        })
      },
    },
  },
})
