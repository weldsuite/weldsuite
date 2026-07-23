/**
 * appApi-backed runner + guarded entry point for flushing the mail outbox.
 *
 * Kept separate from outbox.ts (which is pure) so the engine stays unit-testable
 * without the network layer. The runner translates each queued op into its
 * concrete appApi call; flushMailOutbox() guards against concurrent flushes per
 * org so an op can't be replayed twice (it's removed from the queue only after
 * its request resolves).
 */

import appApi from '@/services/app-api';
import { isNetworkError } from '@weldsuite/api-client/client';
import { flushOutbox, type FlushResult, type OpRunner } from './outbox';

const runner: OpRunner = async (op) => {
  switch (op.kind) {
    case 'update':
      await appApi.mailMessages.update(op.messageId, op.patch);
      return;
    case 'delete':
      await appApi.mailMessages.delete(op.messageId);
      return;
    case 'archive':
      // Mirror the inline archive: add ARCHIVE, drop INBOX.
      await appApi.mailMessages.addLabels(op.messageId, { labels: ['ARCHIVE'] });
      await appApi.mailMessages.removeLabels(op.messageId, { labels: ['INBOX'] });
      return;
    case 'snooze':
      await appApi.mailSnooze.snooze(op.accountId, op.messageId, { until: op.until });
      return;
    case 'unsnooze':
      await appApi.mailSnooze.unsnooze(op.accountId, op.messageId);
      return;
    case 'send':
      // Carries an idempotencyKey in the payload, so a replay after a dropped
      // response is deduped server-side rather than sending twice.
      await appApi.mailAccounts.send(op.accountId, op.payload);
      return;
  }
};

const inFlight = new Set<string>();

/** Flush one org's outbox. No-ops if a flush for that org is already running. */
export async function flushMailOutbox(orgId: string): Promise<FlushResult | null> {
  if (inFlight.has(orgId)) return null;
  inFlight.add(orgId);
  try {
    return await flushOutbox(orgId, runner, isNetworkError);
  } finally {
    inFlight.delete(orgId);
  }
}
