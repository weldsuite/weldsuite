import { createServerFn } from '@tanstack/react-start';
import { getAdminIdentity } from './auth';
import { isSignedIn } from './server/identity';

/**
 * The session the root route checks before every page: signed in at all (else
 * the sign-in page), and the admin identity (null for someone signed in who
 * isn't an admin). Replaces Next's `middleware.ts` and the root layout's lookup.
 */
export const getAdminSession = createServerFn({ method: 'GET' }).handler(async () => {
  const [signedIn, identity] = await Promise.all([isSignedIn(), getAdminIdentity()]);
  return { signedIn, identity };
});
