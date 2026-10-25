import { createFileRoute } from '@tanstack/react-router'
import { postJson, requestDomain } from '@/lib/server/upstream'

/**
 * "Was this article helpful?" votes. A server route rather than a direct call
 * from the browser, so desk-api's origin stays server-side (FE-008). The help
 * center is the one this host serves; the browser doesn't get to name it.
 */
export const Route = createFileRoute('/api/feedback')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const domain = requestDomain(request)
        const body = (await request.json().catch(() => null)) as
          | { articleId?: unknown; helpful?: unknown }
          | null

        if (!domain || typeof body?.articleId !== 'string' || !body.articleId || typeof body.helpful !== 'boolean') {
          return Response.json({ error: 'Missing required fields' }, { status: 400 })
        }

        const res = await postJson(
          `/articles/${encodeURIComponent(body.articleId)}/feedback`,
          domain,
          { helpful: body.helpful },
        )
        if (!res.ok) {
          return Response.json({ error: 'Failed to submit feedback' }, { status: res.status })
        }
        return Response.json({ success: true })
      },
    },
  },
})
