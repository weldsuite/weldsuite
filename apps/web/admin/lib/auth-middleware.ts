import { clerkMiddleware } from '@clerk/tanstack-react-start/server';

/**
 * The request middleware that reads who is signed in: Clerk's, on Global. The
 * Node build for Kubernetes resolves this module to `auth-middleware.node.ts`
 * (vite.config.ts), which has none yet.
 */
export const authRequestMiddleware: ReturnType<typeof clerkMiddleware>[] = [clerkMiddleware()];
