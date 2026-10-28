/**
 * Resolves this request's `{ mode, store, access }` (design §2,
 * `@weldsuite/mail-domain/store`'s `getWorkspaceMail`) from an app-api route's
 * Hono context, once per request. The dashboard sidebar badge
 * (`routes/dashboard/index.ts`) and drive aggregation (`services/drive-
 * aggregation.ts`, via `routes/drive/index.ts`) call this instead of reading
 * `mail_messages`/`mail_accounts` through `@weldsuite/mail-domain` functions
 * directly, so both read through the store/access abstraction in every mode
 * (design task D6).
 *
 * Mirrors mail-api's own `lib/mail-store-context.ts` (workers never import
 * each other's folders, so this is a deliberate small duplication, not a
 * shared import) — see that file's header comment for the two adapters this
 * also needs over the factory's `GetWorkspaceMailOptions`:
 *
 * - `c.env` types `MAIL_STORAGE` (and `MAILBOX_STORE`/`MAIL_INDEX`) as
 *   optional, but `MailStoreEnv` requires `MAIL_STORAGE` — wrangler.toml
 *   binds it in every environment already (design §8), so the worker never
 *   actually runs without it; the cast only papers over the
 *   optional-vs-required mismatch between this worker's own `Env` and the
 *   store's env contract, not a real runtime gap.
 * - `c.executionCtx.waitUntil` throws outside a real Workers runtime (a bare
 *   Hono app built without `createTestApp`'s execution context stub); the
 *   same defensive pattern `lib/read-push.ts`-style callers use elsewhere in
 *   this worker.
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
 * whatever `requirePermission` (run earlier in the chain, where the route has
 * one) already cached on the context, so `MailAccess.isAdmin()` in
 * object/object-only modes costs nothing beyond what the route already paid
 * for (design §2's `GetWorkspaceMailOptions.role` doc comment). A route with
 * no permission gate of its own (the dashboard's sidebar badge) simply gets
 * `role: null`, which falls back to a live permissions lookup only in
 * object/object-only mode.
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
