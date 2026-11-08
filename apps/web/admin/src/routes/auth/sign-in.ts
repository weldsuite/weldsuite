import { createFileRoute } from '@tanstack/react-router';
import { GLOBAL } from '@/lib/edition';

/** Staff sign-in on Kubernetes: off to the install's identity provider (lib/server/auth-routes.ts). Global uses Clerk. */
export const Route = createFileRoute('/auth/sign-in')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (GLOBAL) return new Response('Not found', { status: 404 });
        const { handleSignIn } = await import('@/lib/server/auth-routes');
        return handleSignIn(request);
      },
    },
  },
});
