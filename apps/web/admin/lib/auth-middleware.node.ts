import type * as Clerk from './auth-middleware';

/** The Node version of `auth-middleware.ts`: nobody signs in yet (`lib/server/identity.node.ts`). */
export const authRequestMiddleware: typeof Clerk.authRequestMiddleware = [];
