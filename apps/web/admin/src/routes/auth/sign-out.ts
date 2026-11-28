import { createFileRoute } from '@tanstack/react-router';

/** Staff sign-out, a same-site POST (lib/server/auth-routes.ts). */
export const Route = createFileRoute('/auth/sign-out')({
  server: {
    handlers: {
      // A link or a prefetch never signs anyone out.
      GET: () => new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } }),
      POST: async ({ request }) => {
        const { handleSignOut } = await import('@/lib/server/auth-routes');
        return handleSignOut(request);
      },
    },
  },
});
