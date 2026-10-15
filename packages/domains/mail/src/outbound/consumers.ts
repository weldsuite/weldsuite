/**
 * Queue consumers for the outbound guard, run by mail-api's `queue()` handler:
 *
 * - `mail-outbound-review-<env>`: AI reviews of templates the ledgers queued.
 * - `mail-sending-events-<env>`: Cloudflare Email Sending events (Queues event
 *   subscriptions, one per sending domain).
 */

import { classifyOutboundTemplate, type ClassifyTemplateFn, type OutboundReviewMessage, type ReviewEnv } from './review';
import { applySendingEvents, parseSendingEvent, type DeliveryEventsEnv, type ParsedSendingEvent } from './delivery-events';
import { ledgerKeyFor } from './ledger-core';
import type { OutboundLedger } from './ledger';

export type { OutboundReviewMessage } from './review';

export interface OutboundReviewEnv extends ReviewEnv {
  OUTBOUND_LEDGER?: DurableObjectNamespace<OutboundLedger>;
}

/** AI-review each template and hand the verdict to its ledger. Failed classifications are acked: the heuristics carry on. */
export async function handleOutboundReviewBatch(
  batch: MessageBatch<OutboundReviewMessage>,
  env: OutboundReviewEnv,
  classify: ClassifyTemplateFn = classifyOutboundTemplate,
): Promise<void> {
  for (const message of batch.messages) {
    const { subject, request } = message.body;
    try {
      const verdict = await classify(
        env,
        {
          subject: request.subject,
          text: request.sample,
          context: {
            firstContactRecipients: request.firstContactRecipients,
            recipients: request.recipients,
            sources: request.sources,
            trustLevel: request.trustLevel,
          },
        },
        { workspaceId: subject.kind === 'workspace' ? subject.workspaceId : null, fingerprint: request.fingerprint },
      );
      if (verdict && env.OUTBOUND_LEDGER) {
        const ns = env.OUTBOUND_LEDGER;
        await ns
          .get(ns.idFromName(ledgerKeyFor(subject)))
          .recordVerdict(verdict, { staffRequested: request.reason === 'staff' });
      }
      message.ack();
    } catch (err) {
      console.error('[outbound-review] failed:', err instanceof Error ? err.message : err);
      message.retry();
    }
  }
}

/** Parse and apply Cloudflare Email Sending events; malformed messages are acked and dropped. */
export async function handleSendingEventsBatch(batch: MessageBatch<unknown>, env: DeliveryEventsEnv): Promise<void> {
  const parsed: ParsedSendingEvent[] = [];
  for (const message of batch.messages) {
    const event = parseSendingEvent(message.body);
    if (event) parsed.push(event);
  }
  if (parsed.length > 0) {
    try {
      await applySendingEvents(env, parsed);
    } catch (err) {
      console.error('[outbound-events] batch failed, retrying:', err instanceof Error ? err.message : err);
      batch.retryAll();
      return;
    }
  }
  batch.ackAll();
}
