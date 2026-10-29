/**
 * Resolves a request's `{ mode, store, access }` (`getWorkspaceMail`, this
 * folder's `index.ts`) from an API worker's Hono context, once per request.
 *
 * Five workers (mail-api, app-api, crm-api, external-api, mcp-server) each
 * carried a near-identical `lib/mail-store-context.ts` wrapping
 * `getWorkspaceMail` in the same two adapters over its
 * `GetWorkspaceMailOptions` (workers never import each other's folders, so
 * each kept its own copy). This is that wrapper, generalized, so a worker's
 * own file can shrink to a one-line delegation typed against its own
 * `Env`/`Variables`:
 *
 * - `c.env` types the mail-store bindings (`MAIL_STORAGE`, `MAILBOX_STORE`,
 *   `MAIL_INDEX`, …) as optional in a worker's own `Env` (only actually read
 *   in object modes), while `MailStoreEnv` requires them — every worker's
 *   `wrangler.toml` binds them in every environment regardless (mailbox
 *   storage design §8), so the cast only papers over the
 *   optional-vs-required mismatch between a worker's own `Env` and the
 *   store's env contract, not a real runtime gap.
 * - `c.executionCtx.waitUntil` throws outside a real Workers runtime (a
 *   hand-built Hono app in a unit test without a stubbed execution
 *   context); defensively no-op in that case instead, the same pattern
 *   `read-push.ts`'s `queueMailReadPush` uses.
 *
 * What differs between the five original callers — whether the caller
 * already has a {@link MailPrincipal} (external-api/mcp-server's
 * API-key/OAuth sessions, which can be a workspace key with no user behind
 * it) or just a Clerk `userId` (every other worker), and whether a role is
 * already cached on the context by an earlier `requirePermission` (every
 * worker but external-api/mcp-server, whose API sessions never run it) — is
 * expressed as {@link WorkspaceMailFromContextOptions}, not a worker-specific
 * copy of this file.
 */

import type { Context, ExecutionContext } from 'hono';
import { getPermissionsFromContext } from '@weldsuite/permissions/server';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailPrincipal } from '../access';
import { getWorkspaceMail, type MailStoreEnv, type WorkspaceMail } from './index';

/**
 * The context variables `workspaceMailFromContext` needs, regardless of
 * which worker's own `Variables` type actually carries them. `clerkOrgId`
 * and `userId` are optional here only because external-api/mcp-server's
 * `Variables` types declare them that way (a workspace key has no user, and
 * a workspace without a Clerk org leaves `clerkOrgId` unset); every other
 * worker's `KitVariables`-based `Variables` type satisfies this with both
 * required.
 */
export interface MailStoreContextVariables {
  workspaceId: string;
  clerkOrgId?: string;
  tenantDb: Database;
  userId?: string;
}

/**
 * A worker's own `Context<{ Bindings: Env; Variables: Variables }>`, as long
 * as its `Variables` covers {@link MailStoreContextVariables}. A worker
 * calls `workspaceMailFromContext(c)` with its own concrete `Context` type
 * and TypeScript infers `TEnv`/`TVariables` from it — no explicit type
 * arguments needed at the call site.
 */
export type MailStoreHonoContext<
  TEnv extends object = Record<string, unknown>,
  TVariables extends MailStoreContextVariables = MailStoreContextVariables,
> = Context<{ Bindings: TEnv; Variables: TVariables }>;

export interface WorkspaceMailFromContextOptions {
  /**
   * The request's mail principal, when the caller already has one — e.g.
   * external-api/mcp-server's own `mailPrincipal(c)`, built from the
   * API-key session or `McpSession`, which can be a `{ kind: 'workspace' }`
   * key with no user behind it. Omitted ⇒ `{ kind: 'user', userId:
   * c.get('userId') }`, right for every Clerk-session worker.
   */
  principal?: MailPrincipal;
  /**
   * Pre-resolved role for `MailAccess.isAdmin()` in object/object-only
   * modes (`GetWorkspaceMailOptions.role`'s own doc comment). Omitted ⇒
   * `getPermissionsFromContext(c)?.role ?? null`: whatever
   * `requirePermission` already cached on the context, for free, on every
   * worker that ran it first; `null` (⇒ `getWorkspaceMail` resolves it
   * lazily) on a context — an external-api/mcp-server API session — that
   * never did. `null` and `undefined` behave identically to
   * `getWorkspaceMail` (it checks `options.role != null`), so passing this
   * default through unconditionally is safe even for callers that used to
   * leave the field unset entirely.
   */
  role?: string | null;
}

/** Never throws: a route running outside a real Workers runtime (a hand-built Hono app in a unit test) still gets a usable no-op. */
function contextWaitUntil(c: { readonly executionCtx: ExecutionContext }): (p: Promise<unknown>) => void {
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
 * Builds `{ mode, store, access }` for the calling route. `role` is read
 * from whatever `requirePermission` (run earlier in the chain, where the
 * route has one) already cached on the context by default, so
 * `MailAccess.isAdmin()` in object/object-only modes costs nothing beyond
 * what the route already paid for.
 *
 * Resolves afresh on every call — a handler that needs it more than once in
 * one request should call this once and pass the result down rather than
 * calling it again.
 */
export async function workspaceMailFromContext<
  TEnv extends object = Record<string, unknown>,
  TVariables extends MailStoreContextVariables = MailStoreContextVariables,
>(c: MailStoreHonoContext<TEnv, TVariables>, options: WorkspaceMailFromContextOptions = {}): Promise<WorkspaceMail> {
  const role = options.role !== undefined ? options.role : (getPermissionsFromContext(c)?.role ?? null);
  return getWorkspaceMail(c.env as unknown as MailStoreEnv, {
    workspaceId: c.get('workspaceId'),
    clerkOrgId: c.get('clerkOrgId') ?? '',
    db: c.get('tenantDb'),
    waitUntil: contextWaitUntil(c),
    role,
    ...(options.principal ? { principal: options.principal } : { userId: c.get('userId') }),
  });
}
