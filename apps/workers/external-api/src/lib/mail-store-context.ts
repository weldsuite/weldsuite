/**
 * Thin per-worker wrapper around the shared `getWorkspaceMail` glue
 * (`@weldsuite/mail-domain/store/hono`), typed against external-api's own
 * `HonoEnv` and supplying this worker's own principal resolution. Every
 * route under `routes/v1/{mail-messages,mail-threads,mail-labels,
 * mail-attachments,mail-drafts}` calls `workspaceMailFromContext` from
 * here, unchanged, instead of reaching into `c.get('tenantDb')` through the
 * mail-domain functions directly, so reads and organize ops work the same
 * in every mailbox-store mode (design task D5).
 *
 * Kept identical to mcp-server's copy (`src/api/lib/mail-store-context.ts`),
 * like the route files and `lib/mail.ts` that use it.
 *
 * `role` is left to the shared helper's default, unlike mail-api's own
 * wrapper: a platform route has already run `requirePermission` by the time
 * it gets here and the default picks that up for free, but an API session
 * hasn't — design §6: "External API and MCP user principals take the role
 * from `resolveEffectivePermissionsCached`" — so `getWorkspaceMail` resolves
 * it lazily (and caches it) for a `{ kind: 'user' }` principal. A `{ kind:
 * 'workspace' }` principal (a `wsk_`/`wsat_` key) ignores `role` entirely:
 * it's never an admin, and reaches shared mailboxes only (design §6).
 */

import type { Context } from 'hono';
import type { WorkspaceMail } from '@weldsuite/mail-domain/store';
import { workspaceMailFromContext as workspaceMailFromContextShared } from '@weldsuite/mail-domain/store/hono';
import { mailPrincipal } from './mail';
import type { HonoEnv } from '../types';

export function workspaceMailFromContext(c: Context<HonoEnv>): Promise<WorkspaceMail> {
  // `role: null` (rather than the shared helper's `getPermissionsFromContext`
  // default) — an API session never populates that cache, so this always
  // resolved lazily; passing it explicitly keeps that true regardless of
  // what else might run earlier in a future request.
  return workspaceMailFromContextShared(c, { principal: mailPrincipal(c), role: null });
}
