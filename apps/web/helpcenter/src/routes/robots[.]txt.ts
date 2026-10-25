import { createFileRoute } from '@tanstack/react-router'
import { requestDomain } from '@/lib/server/upstream'

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const domain = requestDomain(request)
        if (!domain) return new Response('Not found', { status: 404 })
        const body = ['User-Agent: *', 'Allow: /', '', `Sitemap: https://${domain}/sitemap.xml`, ''].join('\n')
        return new Response(body, { headers: { 'Content-Type': 'text/plain' } })
      },
    },
  },
})
