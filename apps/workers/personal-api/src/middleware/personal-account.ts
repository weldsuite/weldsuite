/**
 * Load personal_accounts by Clerk user id after auth.
 *
 * /api/onboard and /api/me may proceed without an account (variables set to null).
 * All other /api/* routes require an account.
 */

import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import { getMasterDb, masterSchema } from '../db';
import { error } from '../lib/response';
import type { Env, Variables } from '../types';

function allowsMissingAccount(path: string): boolean {
  return (
    path === '/api/onboard' ||
    path.startsWith('/api/onboard/') ||
    path === '/api/me' ||
    path.startsWith('/api/me/') ||
    // Availability + domain lookup happen before the user has a personal
    // account (workspace users adding a personal inbox from Add account).
    path === '/api/mail/weldmail/domain' ||
    path === '/api/mail/weldmail/check'
  );
}

export const personalAccountMiddleware = () => {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const userId = c.get('userId');
    const path = c.req.path;

    try {
      const masterDb = getMasterDb(c.env);
      const [row] = await masterDb
        .select({
          id: masterSchema.personalAccounts.id,
          clerkUserId: masterSchema.personalAccounts.clerkUserId,
          displayName: masterSchema.personalAccounts.displayName,
        })
        .from(masterSchema.personalAccounts)
        .where(eq(masterSchema.personalAccounts.clerkUserId, userId))
        .limit(1);

      if (!row) {
        c.set('personalAccountId', null);
        c.set('personalAccount', null);

        if (!allowsMissingAccount(path)) {
          return error.personalAccountRequired(c);
        }

        await next();
        return;
      }

      c.set('personalAccountId', row.id);
      c.set('personalAccount', {
        id: row.id,
        clerkUserId: row.clerkUserId,
        displayName: row.displayName,
      });

      await next();
    } catch (err) {
      console.error('[personal-account] lookup failed:', err);
      return error.internal(c, 'Failed to load personal account');
    }
  });
};
