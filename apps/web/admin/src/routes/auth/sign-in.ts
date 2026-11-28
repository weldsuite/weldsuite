import { createFileRoute } from '@tanstack/react-router';

/** Staff sign-in: off to the install's identity provider (lib/server/auth-routes.ts). */
export const Route = createFileRoute('/auth/sign-in')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleSignIn } = await import('@/lib/server/auth-routes');
        return handleSignIn(request);
      },
    },
  },
});
