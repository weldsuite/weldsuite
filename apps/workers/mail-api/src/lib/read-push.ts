/**
 * Queue the WeldMail "email read" push (see `@weldsuite/mail-domain/read-push`)
 * after a route took messages out of the unread inbox: read, trashed, spammed
 * or deleted. Runs in `waitUntil`, so the response never waits on Expo.
 */

import type { Context } from 'hono';
import { sendWorkspaceMailReadPush } from '@weldsuite/mail-domain/read-push';
import type { Env, Variables } from '../types';

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
  ctx.waitUntil(sendWorkspaceMailReadPush(c.get('tenantDb'), { accountId, emailIds }));
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
