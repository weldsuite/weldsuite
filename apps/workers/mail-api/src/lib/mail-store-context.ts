/**
 * Resolves this request's `{ mode, store, access }` (design §2,
 * `@weldsuite/mail-domain/store`'s `getWorkspaceMail`) from a mail-api route's
 * Hono context, once per request. Every route under `routes/{mail-messages,
 * mail-threads,mail-labels,mail-snooze,mail-attachments,mail-drafts}` calls
 * this instead of reaching into `c.get('tenantDb')` through the mail-domain
 * functions directly, so reads and writes go through the store/access
 * abstraction in every mode (design task D2).
 *
 * Two small adapters over the factory's `GetWorkspaceMailOptions`:
 *
 * - `c.env` types `MAIL_STORAGE` as optional (`Env['MAIL_STORAGE']`, only
 *   actually read in object modes), but `MailStoreEnv` requires it —
 *   `wrangler.toml` binds it in every environment already (design §8), so
 *   the worker never actually runs without it; the cast only papers over the
 *   optional-vs-required mismatch between this worker's own `Env` and the
 *   store's env contract, not a real runtime gap.
 * - `c.executionCtx.waitUntil` throws outside a real Workers runtime (unit
 *   tests that build a bare Hono app without `createTestApp`'s execution
 *   context stub); the same defensive pattern `lib/read-push.ts`'s
 *   `queueMailReadPush` already uses.
 */

import type { Context } from 'hono';
import { getPermissionsFromContext } from '@weldsuite/permissions/server';
import { getWorkspaceMail, type MailStoreEnv, type WorkspaceMail } from '@weldsuite/mail-domain/store';
import type { Env, Variables } from '../types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Never throws: a route running outside a real Workers runtime (a hand-built Hono app in a unit test) still gets a usable no-op. */
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
 * modes costs nothing beyond what the route already paid for (design §2's
 * `GetWorkspaceMailOptions.role` doc comment).
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
