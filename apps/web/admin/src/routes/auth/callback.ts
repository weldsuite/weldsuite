import { createFileRoute } from '@tanstack/react-router';
import { GLOBAL } from '@/lib/edition';

/** The identity provider's redirect back after staff sign in on Kubernetes (lib/server/auth-routes.ts). */
export const Route = createFileRoute('/auth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (GLOBAL) return new Response('Not found', { status: 404 });
        const { handleCallback } = await import('@/lib/server/auth-routes');
        return handleCallback(request);
      },
    },
  },
});
