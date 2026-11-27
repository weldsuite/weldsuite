import { createFileRoute } from '@tanstack/react-router'
import { getPdf } from '@/lib/server/backend'

/**
 * The PDF of a link's document, streamed from the backend so the browser never
 * learns where the backend is. `$token_` keeps it out of the page's layout.
 */
export const Route = createFileRoute('/d/$token_/pdf')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const pdf = await getPdf(params.token)
        if (!pdf.ok) {
          const status = pdf.reason === 'not_found' ? 404 : pdf.reason === 'rate_limited' ? 429 : 502
          return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } })
        }
        return new Response(pdf.response.body, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="document.pdf"',
            'Cache-Control': 'private, no-store',
          },
        })
      },
    },
  },
})
