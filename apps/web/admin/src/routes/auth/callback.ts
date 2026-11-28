import { createFileRoute } from '@tanstack/react-router';

/** The identity provider's redirect back after staff sign in (lib/server/auth-routes.ts). */
export const Route = createFileRoute('/auth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleCallback } = await import('@/lib/server/auth-routes');
        return handleCallback(request);
      },
    },
  },
});
