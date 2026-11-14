import { createFileRoute } from '@tanstack/react-router'
import { proxyToFormsApi } from '@/lib/server/proxy'

/**
 * `/api/*`: what the page's JavaScript calls. Forwarded to forms-api's
 * `/public/forms/*` with the portal's key and the respondent's address added
 * (lib/server/proxy.ts); only the routes the page needs are let through.
 */
export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request, params }) => proxyToFormsApi(request, params._splat ?? ''),
      POST: ({ request, params }) => proxyToFormsApi(request, params._splat ?? ''),
      PUT: ({ request, params }) => proxyToFormsApi(request, params._splat ?? ''),
    },
  },
})
