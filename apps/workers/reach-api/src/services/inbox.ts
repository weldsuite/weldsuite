/**
 * The reply inbox's write side: labelling and read / handled state. The reads
 * and answering a reply are in `@weldsuite/reach-domain/inbox`.
 *
 * A person's label is final (the AI never overwrites it) and has the same
 * effects as one chosen by the model; read and handled state are judged on the
 * LATEST inbound message of a thread, so a new reply reopens a handled thread.
 */

import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import type { ReachReplyLabel, UpdateReachMessageInput } from '@weldsuite/app-api-client/schemas/reach';
import { reachMessages, reachProspects, type ReachMessage } from '@weldsuite/db/schema';
import { applyLabelEffects } from './reply-effects';

const m = reachMessages;

export interface MessageUpdate {
  message: ReachMessage;
  /** Set when the label changed; the route publishes `reach_reply:classified` for it. */
  labelChange: { previous: ReachReplyLabel | null; next: ReachReplyLabel } | null;
}

type MessagePatch = Partial<typeof reachMessages.$inferInsert>;

/** The columns a person's read / handled choice changes. */
function stateColumns(existing: ReachMessage, input: UpdateReachMessageInput, userId: string, now: Date): MessagePatch {
  const patch: MessagePatch = {};
  if (input.handled === true) {
    patch.handledAt = existing.handledAt ?? now;
    patch.handledBy = existing.handledAt ? existing.handledBy : userId;
    // Handled implies seen.
    patch.readAt = existing.readAt ?? now;
  } else if (input.handled === false) {
    patch.handledAt = null;
    patch.handledBy = null;
  }
  if (input.read === true) patch.readAt = existing.readAt ?? now;
  else if (input.read === false && input.handled !== true) patch.readAt = null;
  return patch;
}

/** The label columns when the person actually changes the label; null when nothing changes. */
function labelColumns(existing: ReachMessage, input: UpdateReachMessageInput, now: Date): { patch: MessagePatch; change: NonNullable<MessageUpdate['labelChange']> } | null {
  if (input.label === undefined || input.label === existing.label) return null;
  return {
    patch: { label: input.label, labelSource: 'user', classifiedAt: now },
    change: { previous: existing.label, next: input.label },
  };
}

/** Reading a reply means the replies before it in the thread were seen too. */
async function markEarlierRepliesRead(db: Database, existing: ReachMessage, now: Date): Promise<void> {
  if (!existing.threadKey || !existing.receivedAt) return;
  await db
    .update(m)
    .set({ readAt: now, updatedAt: now })
    .where(and(eq(m.threadKey, existing.threadKey), eq(m.direction, 'in'), isNull(m.readAt), lt(m.receivedAt, existing.receivedAt)));
}

async function applyUserLabel(db: Database, message: ReachMessage, change: NonNullable<MessageUpdate['labelChange']>): Promise<void> {
  const [prospect] = message.prospectId
    ? await db
        .select({ id: reachProspects.id, email: reachProspects.email, companyDomain: reachProspects.companyDomain })
        .from(reachProspects)
        .where(eq(reachProspects.id, message.prospectId))
        .limit(1)
    : [];
  await applyLabelEffects(
    db,
    {
      messageId: message.id,
      senderEmail: message.fromEmail,
      prospect: prospect ?? null,
      enrollmentId: message.enrollmentId,
      campaignId: message.campaignId,
      previousLabel: change.previous,
    },
    change.next,
  );
}

/**
 * Apply a person's change to one inbound message. A label chosen by a person
 * is final (the AI never overwrites it) and has the same effects as one chosen
 * by the model: `unsubscribe` suppresses the address and ends the sequence.
 * Marking a message read also marks the earlier inbound messages of its thread.
 */
export async function updateMessage(
  db: Database,
  id: string,
  input: UpdateReachMessageInput,
  userId: string,
): Promise<MessageUpdate | null> {
  const [existing] = await db.select().from(m).where(and(eq(m.id, id), eq(m.direction, 'in'))).limit(1);
  if (!existing) return null;

  const now = new Date();
  const label = labelColumns(existing, input, now);
  const patch: MessagePatch = { updatedAt: now, ...stateColumns(existing, input, userId, now), ...label?.patch };
  const [updated] = await db.update(m).set(patch).where(eq(m.id, id)).returning();
  if (!updated) return null;

  if (input.read === true) await markEarlierRepliesRead(db, existing, now);
  if (label) await applyUserLabel(db, updated, label.change);
  return { message: updated, labelChange: label?.change ?? null };
}
