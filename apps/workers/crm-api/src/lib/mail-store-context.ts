/**
 * Thin per-worker wrapper around the shared `getWorkspaceMail` glue
 * (`@weldsuite/mail-domain/store/hono`), typed against crm-api's own
 * `Env`/`Variables`. crm-api's only mail-store consumer today is `GET
 * /api/people/recent-correspondents` (docs/plans/weldmail-mailbox-store-
 * design.md, task D7): it needs one mailbox's `recentAddresses`, after its
 * own `checkAccountAccess` (MAIL-003) has already allowed the caller. The
 * two adapters over the factory's `GetWorkspaceMailOptions` (the
 * optional-vs-required `MAIL_STORAGE`-style bindings cast, and the
 * `executionCtx.waitUntil` no-op outside a real Workers runtime) live in the
 * shared helper now — see its doc comment — not duplicated here.
 */

import type { Context } from 'hono';
import type { WorkspaceMail } from '@weldsuite/mail-domain/store';
import { workspaceMailFromContext as workspaceMailFromContextShared } from '@weldsuite/mail-domain/store/hono';
import type { Env, Variables } from '../types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export function workspaceMailFromContext(c: AppContext): Promise<WorkspaceMail> {
  return workspaceMailFromContextShared(c);
}
