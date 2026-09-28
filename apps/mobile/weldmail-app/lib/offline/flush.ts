/**
 * appApi-backed runner + guarded entry point for flushing the mail outbox.
 *
 * Kept separate from outbox.ts (which is pure) so the engine stays unit-testable
 * without the network layer. The runner translates each queued op into its
 * concrete appApi call; flushMailOutbox() guards against concurrent flushes per
 * org so an op can't be replayed twice (it's removed from the queue only after
 * its request resolves).
 */

import { appApi } from '@/services/app-api';
import { personalApi } from '@/services/personal-api';
import { isPersonalMessage, isPersonalAccountId } from '@/services/mail-tenant';
import { isApiError, isNetworkError } from '@weldsuite/api-client/client';
import { flushOutbox, type FlushResult, type OpRunner } from './outbox';

const runner: OpRunner = async (op) => {
  const personal =
    op.personal ??
    ((op.kind === 'send' && isPersonalAccountId(op.accountId)) ||
      (op.kind !== 'send' && isPersonalMessage(op.messageId, 'accountId' in op ? op.accountId : undefined)));

  switch (op.kind) {
    case 'update':
      if (personal) {
        const patch: { isRead?: boolean; isStarred?: boolean } = {};
        if (op.patch.isRead !== undefined) patch.isRead = op.patch.isRead;
        if (op.patch.isStarred !== undefined) patch.isStarred = op.patch.isStarred;
        if (Object.keys(patch).length > 0) {
          await personalApi.mailMessages.patch(op.messageId, patch);
        }
      } else {
        await appApi.mailMessages.update(op.messageId, op.patch);
      }
      return;
    case 'delete':
      if (personal) {
        await personalApi.mailMessages.patch(op.messageId, { isTrash: true });
      } else {
        await appApi.mailMessages.delete(op.messageId);
      }
      return;
    case 'archive':
      if (personal) {
        await personalApi.mailMessages.patch(op.messageId, { labels: ['ARCHIVE'] });
      } else {
        await appApi.mailMessages.addLabels(op.messageId, { labels: ['ARCHIVE'] });
        await appApi.mailMessages.removeLabels(op.messageId, { labels: ['INBOX'] });
      }
      return;
    case 'snooze':
      if (personal) return;
      await appApi.mailSnooze.snooze(op.accountId, op.messageId, { until: op.until });
      return;
    case 'unsnooze':
      if (personal) return;
      await appApi.mailSnooze.unsnooze(op.accountId, op.messageId);
      return;
    case 'send':
      if (personal) {
        await personalApi.mailMessages.send({
          accountId: op.accountId,
          to: op.payload.to,
          cc: op.payload.cc,
          bcc: op.payload.bcc,
          subject: op.payload.subject ?? '',
          textBody: op.payload.body,
          htmlBody: op.payload.htmlBody,
          inReplyTo: op.payload.inReplyTo,
          idempotencyKey: op.payload.idempotencyKey,
        });
      } else {
        await appApi.mailAccounts.send(op.accountId, op.payload);
      }
      return;
  }
};

/**
 * Server errors worth retrying: the request reached the server but failed for a
 * reason that should clear up on its own (5xx, rate limiting, a timeout, or a
 * Clerk token that wasn't ready yet on app resume). Anything else is a rejection.
 */
function isTransientError(e: unknown): boolean {
  if (isApiError(e)) return e.status >= 500 || e.status === 429 || e.status === 408 || e.status === 401;
  return e instanceof Error && e.message === 'Authentication required';
}

const inFlight = new Set<string>();
const rerequested = new Set<string>();

/**
 * Flush one org's outbox. A call that arrives while a flush for that org is
 * already running returns null, but marks the org so the running flush makes
 * one more pass: the op that triggered the call (enqueued after the running
 * pass loaded the queue) is then sent now instead of on the next trigger.
 */
export async function flushMailOutbox(orgId: string): Promise<FlushResult | null> {
  if (inFlight.has(orgId)) {
    rerequested.add(orgId);
    return null;
  }
  inFlight.add(orgId);
  try {
    let result = await flushOutbox(orgId, runner, isNetworkError, isTransientError);
    while (rerequested.has(orgId)) {
      rerequested.delete(orgId);
      const next = await flushOutbox(orgId, runner, isNetworkError, isTransientError);
      result = {
        remaining: next.remaining,
        succeeded: result.succeeded + next.succeeded,
        dropped: result.dropped + next.dropped,
      };
    }
    return result;
  } finally {
    inFlight.delete(orgId);
    rerequested.delete(orgId);
  }
}
