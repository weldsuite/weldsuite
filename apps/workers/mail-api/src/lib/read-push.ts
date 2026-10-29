/**
 * Queue the WeldMail "email read" push (see `@weldsuite/mail-domain/read-push`)
 * after a route took messages out of the unread inbox: read, trashed, spammed
 * or deleted. Runs in `waitUntil`, so the response never waits on Expo.
 *
 * Resolves `workspaceMailFromContext` so the push's per-user `inboxUnread`
 * badge count goes through the mailbox store (design docs/plans/weldmail-
 * mailbox-store-design.md, task D2: "`stats(...).inboxUnread`") instead of a
 * direct `mail_messages` query — byte-identical in `postgres` mode (the
 * store's own `stats()` wraps the same query), the mailbox-store mode's own
 * source of truth in every other mode. `ctx.waitUntil` is called
 * SYNCHRONOUSLY, before the store resolves: Cloudflare Workers only keeps a
 * request alive for promises handed to `waitUntil` before the handler
 * returns, so the async store resolution must happen INSIDE the promise this
 * passes it, not before.
 */

import type { Context } from 'hono';
import { sendWorkspaceMailReadPush } from '@weldsuite/mail-domain/read-push';
import type { Env, Variables } from '../types';
import { workspaceMailFromContext } from './mail-store-context';

export function queueMailReadPush(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  accountId: string,
  emailIds: string[],
): void {
  if (emailIds.length === 0) return;
  let ctx: ExecutionContext;
  try {
    ctx = c.executionCtx;
  } catch {
    // No execution context (route tests): nothing to keep the push alive.
    return;
  }
  const db = c.get('tenantDb');
  ctx.waitUntil(
    workspaceMailFromContext(c)
      .then(({ store }) => sendWorkspaceMailReadPush(db, { accountId, emailIds }, { store }))
      .catch((err) => console.error('[read-push] failed to resolve the mailbox store for the read push:', err)),
  );
}

/**
 * Whether a message update takes it out of the unread inbox: read, trashed,
 * spammed, or given a label set without INBOX (archived, moved to a folder).
 */
export function clearsUnreadBanner(update: {
  isRead?: boolean;
  isTrash?: boolean;
  isSpam?: boolean;
  labels?: string[];
}): boolean {
  return (
    update.isRead === true ||
    update.isTrash === true ||
    update.isSpam === true ||
    (update.labels !== undefined && !update.labels.includes('INBOX'))
  );
}
