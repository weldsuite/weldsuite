import { createFileRoute } from '@tanstack/react-router';
import { GLOBAL } from '@/lib/edition';

/** Staff sign-out on Kubernetes, a same-site POST (lib/server/auth-routes.ts). */
export const Route = createFileRoute('/auth/sign-out')({
  server: {
    handlers: {
      // A link or a prefetch never signs anyone out.
      GET: () =>
        GLOBAL
          ? new Response('Not found', { status: 404 })
          : new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } }),
      POST: async ({ request }) => {
        if (GLOBAL) return new Response('Not found', { status: 404 });
        const { handleSignOut } = await import('@/lib/server/auth-routes');
        return handleSignOut(request);
      },
    },
  },
});
