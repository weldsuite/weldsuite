/**
 * Entity events for the reply inbox, from request handlers and from
 * background code (the `email()` handler, `waitUntil` classification).
 *
 * The inbox is refreshed live by these events: `entity-events-worker` fans
 * every hub message out to the realtime subscriber, which publishes it to the
 * workspace's WorkspaceHub as topic `reach_reply`, event `received` or
 * `classified` (see `entity-realtime-consumer.ts` in realtime-worker). That is
 * the realtime path for WeldReach; there is deliberately no second, direct push
 * to the `REALTIME` binding that would make clients refresh twice.
 *
 * Payloads carry ids, the kind, the sender address and the subject, never the
 * message body: the event reaches every member's socket, the audit log,
 * webhooks and workflows, and not every member may read the inbox.
 */

import { publishEntityEventRaw, type EntityAction, type EntityType } from '@weldsuite/entity-events';
import type { ReachMessage, ReachReplyLabel } from '@weldsuite/db/schema';
import type { Env } from '../types';

export interface SinkEvent {
  entityType: EntityType;
  action: EntityAction;
  entityId: string;
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
}

/** Where entity events go: the hub queue from background code, `publishEntityEvent({ c })` from a route. */
export type EntitySink = (event: SinkEvent) => Promise<void> | void;

/** Context-free sink for code without a Hono context. Never throws. */
export function createRawEntitySink(env: Pick<Env, 'ENTITY_EVENTS'>, clerkOrgId: string, userId = 'system'): EntitySink {
  return async (event) => {
    await publishEntityEventRaw({
      env,
      workspaceId: clerkOrgId,
      userId,
      entityType: event.entityType,
      action: event.action,
      entityId: event.entityId,
      data: event.data,
      changes: event.changes,
    });
  };
}

type EventMessage = Pick<
  ReachMessage,
  | 'id'
  | 'threadKey'
  | 'kind'
  | 'mailboxId'
  | 'campaignId'
  | 'enrollmentId'
  | 'prospectId'
  | 'fromEmail'
  | 'subject'
  | 'receivedAt'
>;

/** The `reach_reply` event payload for one inbound message. */
export function replyEventData(message: EventMessage, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: message.id,
    threadKey: message.threadKey,
    kind: message.kind,
    mailboxId: message.mailboxId,
    campaignId: message.campaignId,
    enrollmentId: message.enrollmentId,
    prospectId: message.prospectId,
    fromEmail: message.fromEmail,
    subject: message.subject,
    receivedAt: message.receivedAt ? message.receivedAt.toISOString() : null,
    ...extra,
  };
}

/** `reach_reply:received`. Best effort: a failed publish never fails reply processing. */
export async function publishReplyReceived(sink: EntitySink, message: EventMessage): Promise<void> {
  try {
    await sink({ entityType: 'reach_reply', action: 'received', entityId: message.id, data: replyEventData(message) });
  } catch (err) {
    console.error('[reach-inbound] reach_reply:received publish failed:', err instanceof Error ? err.message : err);
  }
}

/** `reach_reply:classified`, with the label and who decided it (`ai`, `user` or `rule`). */
export async function publishReplyClassified(
  sink: EntitySink,
  message: EventMessage,
  label: ReachReplyLabel,
  source: 'ai' | 'user' | 'rule',
  previousLabel: ReachReplyLabel | null = null,
): Promise<void> {
  try {
    await sink({
      entityType: 'reach_reply',
      action: 'classified',
      entityId: message.id,
      data: replyEventData(message, { label, labelSource: source }),
      changes: previousLabel === null ? null : { label: { old: previousLabel, new: label } },
    });
  } catch (err) {
    console.error('[reach-inbound] reach_reply:classified publish failed:', err instanceof Error ? err.message : err);
  }
}
