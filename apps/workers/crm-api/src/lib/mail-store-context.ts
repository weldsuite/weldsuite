/**
 * Resolves `{ mode, store, access }` (`@weldsuite/mail-domain/store`'s
 * `getWorkspaceMail`) from a crm-api route's Hono context, once per request.
 *
 * crm-api's only mail-store consumer today is `GET /api/people/recent-
 * correspondents` (docs/plans/weldmail-mailbox-store-design.md, task D7): it
 * needs one mailbox's `recentAddresses`, after its own `checkAccountAccess`
 * (MAIL-003) has already allowed the caller. This mirrors mail-api's
 * `lib/mail-store-context.ts` — same two adapters over
 * `GetWorkspaceMailOptions`, duplicated rather than imported because it's
 * thin, worker-specific glue, not product logic workers should share.
 *
 * - `c.env` types `MAIL_STORAGE` as optional (`Env['MAIL_STORAGE']`, only
 *   actually read in object modes), but `MailStoreEnv` requires it —
 *   `wrangler.toml` binds it in every environment already (design §8), so
 *   this worker never actually runs without it; the cast only papers over the
 *   optional-vs-required mismatch between this worker's own `Env` and the
 *   store's env contract, not a real runtime gap.
 * - `c.executionCtx.waitUntil` throws outside a real Workers runtime (a
 *   hand-built Hono app in a unit test without `createTestApp`'s execution
 *   context stub); defensively no-op in that case instead.
 */

import type { Context } from 'hono';
import { getPermissionsFromContext } from '@weldsuite/permissions/server';
import { getWorkspaceMail, type MailStoreEnv, type WorkspaceMail } from '@weldsuite/mail-domain/store';
import type { Env, Variables } from '../types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Never throws: a route running outside a real Workers runtime still gets a usable no-op. */
function contextWaitUntil(c: AppContext): (p: Promise<unknown>) => void {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return (p) => {
      p.catch(() => {});
    };
  }
}

/**
 * Builds `{ mode, store, access }` for the calling route. `role` is read from
 * whatever `requirePermission` (always run earlier in the chain) already
 * cached on the context, so `MailAccess.isAdmin()` in object/object-only
 * modes costs nothing beyond what the route already paid for.
 *
 * Resolves afresh on every call — a handler that needs it more than once in
 * one request should call this once and pass the result down rather than
 * calling it again.
 */
export async function workspaceMailFromContext(c: AppContext): Promise<WorkspaceMail> {
  const role = getPermissionsFromContext(c)?.role ?? null;
  return getWorkspaceMail(c.env as unknown as MailStoreEnv, {
    workspaceId: c.get('workspaceId'),
    clerkOrgId: c.get('clerkOrgId'),
    db: c.get('tenantDb'),
    waitUntil: contextWaitUntil(c),
    userId: c.get('userId'),
    role,
  });
}
