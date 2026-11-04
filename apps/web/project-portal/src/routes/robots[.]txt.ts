import { createFileRoute } from '@tanstack/react-router'

/** Nothing on the portal is for a search engine. Without this, `/robots.txt` would be read as a workspace. */
export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: () =>
        new Response('User-agent: *\nDisallow: /\n', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
        }),
    },
  },
})
