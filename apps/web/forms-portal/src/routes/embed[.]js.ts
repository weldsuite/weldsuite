import { createFileRoute } from '@tanstack/react-router'
import embedSource from 'virtual:forms-embed'

/**
 * `/embed.js`: the embed SDK (`@weldsuite/forms-embed`), bundled into this app
 * by vite-plugins/forms-embed.ts. Any site may load it.
 */
export const Route = createFileRoute('/embed.js')({
  server: {
    handlers: {
      GET: () =>
        new Response(embedSource, {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'X-Content-Type-Options': 'nosniff',
          },
        }),
    },
  },
})
