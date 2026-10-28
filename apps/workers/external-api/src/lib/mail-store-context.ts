/**
 * Resolves this request's `{ mode, store, access }` (design
 * docs/plans/weldmail-mailbox-store-design.md §2,
 * `@weldsuite/mail-domain/store`'s `getWorkspaceMail`) from a v1 mail route's
 * Hono context, once per request. Every route under
 * `routes/v1/{mail-messages,mail-threads,mail-labels,mail-attachments,
 * mail-drafts}` calls this instead of reaching into `c.get('tenantDb')`
 * through the mail-domain functions directly, so reads and organize ops work
 * the same in every mailbox-store mode (design task D5).
 *
 * Kept identical to mcp-server's copy (`src/api/lib/mail-store-context.ts`),
 * like the route files and `lib/mail.ts` that use it.
 *
 * `role` is left unset, unlike mail-api's own copy of this helper: a platform
 * route has already run `requirePermission` by the time it gets here, so it
 * passes the resolved role along for free. An API session hasn't — design §6:
 * "External API and MCP user principals take the role from
 * `resolveEffectivePermissionsCached`" — so `getWorkspaceMail` resolves it
 * lazily (and caches it) for a `{ kind: 'user' }` principal. A `{ kind:
 * 'workspace' }` principal (a `wsk_`/`wsat_` key) ignores `role` entirely:
 * it's never an admin, and reaches shared mailboxes only (design §6).
 */

import type { Context } from 'hono';
import { getWorkspaceMail, type MailStoreEnv, type WorkspaceMail } from '@weldsuite/mail-domain/store';
import { mailPrincipal } from './mail';
import type { HonoEnv } from '../types';

/**
 * Never throws: a route running outside a real Workers runtime (a hand-built
 * Hono app in a unit test) still gets a usable no-op — the same defensive
 * pattern mail-api's own copy and `lib/read-push.ts`-style helpers use.
 */
function contextWaitUntil(c: Context<HonoEnv>): (p: Promise<unknown>) => void {
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
 * Builds `{ mode, store, access }` for the calling route.
 *
 * Resolves afresh on every call — a handler that needs it more than once in
 * one request should call this once and pass the result down rather than
 * calling it again.
 */
export async function workspaceMailFromContext(c: Context<HonoEnv>): Promise<WorkspaceMail> {
  return getWorkspaceMail(c.env as unknown as MailStoreEnv, {
    workspaceId: c.get('workspaceId'),
    // A workspace without a Clerk org (rare: `clerkOrgId` is only set once the
    // auth middleware resolves one) never actually reaches a mode other than
    // `postgres`, where `WorkspaceMailStore.clerkOrgId` goes unread — see
    // `MailStoreEnv`'s own doc comment on bindings a `postgres`-only worker
    // never calls.
    clerkOrgId: c.get('clerkOrgId') ?? '',
    db: c.get('tenantDb'),
    waitUntil: contextWaitUntil(c),
    principal: mailPrincipal(c),
  });
}
