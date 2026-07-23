/**
 * WeldDesk v2 — conversation-parts append service. THE single choke point.
 *
 * Every mutation to a desk_conversation (reply, note, state change,
 * assignment, snooze, rating, ...) MUST go through `appendPart()`. It is the
 * only place that:
 *   1. Loads the current conversation row.
 *   2. Computes the part's side effects (state, waitingSince, snoozedUntil,
 *      assignees, read, conversationRating, statistics rollup).
 *   3. Inserts the append-only part row (stateSnapshot = state AFTER effects).
 *   4. Writes the updated conversation row.
 *
 * No route or other service may write to desk_conversation_parts, or to the
 * state/waitingSince/statistics columns of desk_conversations, directly —
 * that's what desyncs the stats rollup (see plan §7 risk #2).
 *
 * IMPORTANT — no multi-statement DB transaction here. The tenant DB is Neon's
 * HTTP driver (`drizzle-orm/neon-http`), which throws "No transactions
 * support" for `db.transaction()`. Steps 3+4 below are two sequential
 * `await`s, not one atomic unit; this is a known gap (see plan §7 risk #1 —
 * closed properly once the conversation Durable Object lands in Phase 3 and
 * becomes the single serialization point per conversation). Until then,
 * concurrent part-appends on the SAME conversation are not race-safe.
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type {
  DeskConversation,
  DeskConversationAiAgent,
  DeskConversationRating,
  DeskConversationState,
  DeskConversationStatistics,
} from '@weldsuite/db/schema/desk-conversations';
import type {
  DeskConversationPart,
  DeskPartAttachment,
  DeskPartAttributeChange,
  DeskPartAuthorType,
  DeskPartEmailMetadata,
  DeskPartType,
} from '@weldsuite/db/schema/desk-conversation-parts';

const conversations = schema.deskConversations;
const parts = schema.deskConversationParts;

/** Reply-time samples retained for the rolling median (newest kept, oldest dropped). */
const MAX_REPLY_TIME_SAMPLES = 200;

export class DeskConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation '${conversationId}' not found`);
    this.name = 'DeskConversationNotFoundError';
  }
}

export interface AppendPartInput {
  conversationId: string;
  partType: DeskPartType;
  authorType: DeskPartAuthorType;
  authorId?: string | null;
  body?: string | null;
  blocks?: DeskConversationPart['blocks'];
  blockResponses?: DeskConversationPart['blockResponses'];
  attachments?: DeskPartAttachment[];
  fromAiAgent?: boolean;
  isAiAnswer?: boolean;
  emailMessageId?: string | null;
  emailMetadata?: DeskPartEmailMetadata;
  attributeChange?: DeskPartAttributeChange;
  metadata?: Record<string, unknown>;

  /** Snooze target — required for partType='snoozed'. */
  snoozedUntil?: Date;
  /** Assignment target — required for partType='assignment' | 'assign_and_unsnooze' | 'away_mode_assignment' | 'default_assignment' | 'balanced_assignment'. */
  assignedToType?: 'admin' | 'team';
  assignedToId?: string | null;
  /** Rating payload — required for partType='conversation_rating_changed'. */
  rating?: DeskConversationRating;
}

export interface AppendPartResult {
  conversation: DeskConversation;
  part: DeskConversationPart;
}

function emptyStatistics(): DeskConversationStatistics {
  return { countReopens: 0, countAssignments: 0, countParts: 0 };
}

/** Push a new reply-time sample (seconds) and recompute the median, capped at MAX_REPLY_TIME_SAMPLES (newest kept). */
function pushReplyTimeSample(stats: DeskConversationStatistics, seconds: number): void {
  const samples = [...(stats.replyTimes ?? []), seconds];
  stats.replyTimes = samples.length > MAX_REPLY_TIME_SAMPLES
    ? samples.slice(samples.length - MAX_REPLY_TIME_SAMPLES)
    : samples;
  const sorted = [...stats.replyTimes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  stats.medianTimeToReply =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * True when `otherAuthorId` counts as "someone other than the current
 * assignee" for unsnooze purposes. A teammate replying/noting who is NOT the
 * conversation's own admin assignee unsnoozes; the assignee's own activity
 * does not. Customer replies always unsnooze (handled by the caller before
 * this is consulted). Bot/team authorship is treated as "someone else".
 */
function isDifferentFromAssignee(
  conversation: Pick<DeskConversation, 'adminAssigneeId'>,
  authorType: DeskPartAuthorType,
  authorId?: string | null,
): boolean {
  if (authorType !== 'admin') return true;
  if (!conversation.adminAssigneeId) return true;
  return authorId !== conversation.adminAssigneeId;
}

/**
 * Compute the conversation-row patch for a given part, given the CURRENT
 * conversation row. Mutates a fresh `statistics` object (never the caller's)
 * and returns everything appendPart needs to persist.
 */
function computeEffects(
  current: DeskConversation,
  input: AppendPartInput,
  now: Date,
): {
  patch: Partial<DeskConversation>;
  stateSnapshot: DeskConversationState;
} {
  const stats: DeskConversationStatistics = { ...(current.statistics ?? emptyStatistics()) };
  stats.countParts = (stats.countParts ?? 0) + 1;

  const patch: Partial<DeskConversation> = { statistics: stats, updatedAt: now };
  let state: DeskConversationState = current.state;

  const nowIso = now.toISOString();

  switch (input.partType) {
    case 'comment': {
      if (input.authorType === 'user') {
        // Customer reply — the ball is in our court.
        patch.waitingSince = now;
        stats.lastContactReplyAt = nowIso;
        if (!stats.firstContactReplyAt) stats.firstContactReplyAt = nowIso;

        // A customer reply always unsnoozes, and reopens a closed conversation.
        if (current.state === 'snoozed') state = 'open';
        if (current.state === 'closed') {
          state = 'open';
          stats.countReopens = (stats.countReopens ?? 0) + 1;
        }
      } else {
        // Admin/bot reply — ball moves to the customer's court.
        patch.waitingSince = null;
        stats.lastAdminReplyAt = nowIso;
        if (!stats.firstAdminReplyAt) {
          stats.firstAdminReplyAt = nowIso;
          if (stats.firstContactReplyAt) {
            stats.timeToAdminReply = Math.max(
              0,
              Math.round((now.getTime() - new Date(stats.firstContactReplyAt).getTime()) / 1000),
            );
          }
        }
        // Reply-time sample: seconds since the conversation started waiting.
        if (current.waitingSince) {
          const seconds = Math.max(0, Math.round((now.getTime() - current.waitingSince.getTime()) / 1000));
          pushReplyTimeSample(stats, seconds);
        }

        // Admin/bot reply on a snoozed conversation unsnoozes it UNLESS it's
        // the assignee's own reply (handled by the caller choosing partType
        // 'comment' vs relying on this default — the assignee-own-reply
        // exception is enforced by the ROUTE deciding whether to also emit an
        // 'unsnoozed' part; see reply-with-unsnooze-check helper below).
      }
      break;
    }

    case 'note':
    case 'note_and_reopen': {
      // Notes never touch waitingSince. note_and_reopen reopens a closed conversation.
      if (input.partType === 'note_and_reopen' && current.state === 'closed') {
        state = 'open';
        stats.countReopens = (stats.countReopens ?? 0) + 1;
      }
      break;
    }

    case 'quick_reply': {
      // Customer clicked a reply button — same effect as a customer comment.
      patch.waitingSince = now;
      stats.lastContactReplyAt = nowIso;
      if (!stats.firstContactReplyAt) stats.firstContactReplyAt = nowIso;
      if (current.state === 'snoozed') state = 'open';
      if (current.state === 'closed') {
        state = 'open';
        stats.countReopens = (stats.countReopens ?? 0) + 1;
      }
      break;
    }

    case 'close': {
      state = 'closed';
      stats.lastCloseAt = nowIso;
      stats.lastClosedById = input.authorId ?? undefined;
      if (!stats.firstCloseAt) {
        stats.firstCloseAt = nowIso;
        if (stats.firstAssignmentAt) {
          stats.timeToFirstClose = Math.max(
            0,
            Math.round((now.getTime() - new Date(stats.firstAssignmentAt).getTime()) / 1000),
          );
        } else {
          stats.timeToFirstClose = Math.max(
            0,
            Math.round((now.getTime() - current.createdAt.getTime()) / 1000),
          );
        }
      }
      stats.timeToLastClose = Math.max(0, Math.round((now.getTime() - current.createdAt.getTime()) / 1000));
      if (stats.firstAssignmentAt) {
        stats.handlingTime = Math.max(
          0,
          Math.round((now.getTime() - new Date(stats.firstAssignmentAt).getTime()) / 1000),
        );
      }
      break;
    }

    case 'open': {
      if (current.state === 'closed') stats.countReopens = (stats.countReopens ?? 0) + 1;
      state = 'open';
      break;
    }

    case 'snoozed': {
      state = 'snoozed';
      patch.snoozedUntil = input.snoozedUntil ?? null;
      break;
    }

    case 'unsnoozed':
    case 'timer_unsnooze': {
      state = 'open';
      patch.snoozedUntil = null;
      break;
    }

    case 'assignment':
    case 'away_mode_assignment':
    case 'default_assignment':
    case 'balanced_assignment': {
      stats.countAssignments = (stats.countAssignments ?? 0) + 1;
      if (!stats.firstAssignmentAt) {
        stats.firstAssignmentAt = nowIso;
        stats.timeToAssignment = Math.max(
          0,
          Math.round((now.getTime() - current.createdAt.getTime()) / 1000),
        );
      }
      stats.lastAssignmentAt = nowIso;

      if (input.assignedToType === 'admin') {
        // Teammate-assign PRESERVES the current team assignment.
        patch.adminAssigneeId = input.assignedToId || null;
      } else if (input.assignedToType === 'team') {
        // Team-assign CLEARS the teammate assignment.
        patch.teamAssigneeId = input.assignedToId || null;
        patch.adminAssigneeId = null;
      }
      break;
    }

    case 'assign_and_unsnooze': {
      stats.countAssignments = (stats.countAssignments ?? 0) + 1;
      if (!stats.firstAssignmentAt) {
        stats.firstAssignmentAt = nowIso;
        stats.timeToAssignment = Math.max(
          0,
          Math.round((now.getTime() - current.createdAt.getTime()) / 1000),
        );
      }
      stats.lastAssignmentAt = nowIso;
      if (input.assignedToType === 'admin') {
        patch.adminAssigneeId = input.assignedToId || null;
      } else if (input.assignedToType === 'team') {
        patch.teamAssigneeId = input.assignedToId || null;
        patch.adminAssigneeId = null;
      }
      state = 'open';
      patch.snoozedUntil = null;
      break;
    }

    case 'conversation_rating_changed': {
      if (input.rating) patch.conversationRating = input.rating;
      break;
    }

    default:
      // Event-only parts (participant_added/removed, ticket_*, workflow_*,
      // ai_answer, ai_handover, linked_object_*, conversation_rating_remark_added)
      // carry no conversation-row side effect beyond countParts/updatedAt.
      break;
  }

  patch.state = state;
  return { patch, stateSnapshot: state };
}

/**
 * Append one part to a conversation's timeline and apply its side effects to
 * the conversation row. See the module docblock for the transaction caveat.
 */
export async function appendPart(db: Database, input: AppendPartInput): Promise<AppendPartResult> {
  const [current] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  if (!current) throw new DeskConversationNotFoundError(input.conversationId);

  const now = new Date();
  const { patch, stateSnapshot } = computeEffects(current, input, now);

  const partId = generateId('dpart');
  await db.insert(parts).values({
    id: partId,
    conversationId: input.conversationId,
    partType: input.partType,
    body: input.body ?? null,
    blocks: input.blocks ?? null,
    blockResponses: input.blockResponses ?? null,
    authorType: input.authorType,
    authorId: input.authorId ?? null,
    fromAiAgent: input.fromAiAgent ?? false,
    isAiAnswer: input.isAiAnswer ?? false,
    assignedToType: input.assignedToType ?? null,
    assignedToId: input.assignedToId ?? null,
    attachments: input.attachments ?? null,
    emailMessageId: input.emailMessageId ?? null,
    emailMetadata: input.emailMetadata ?? null,
    attributeChange: input.attributeChange ?? null,
    stateSnapshot,
    metadata: input.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  });

  await db.update(conversations).set(patch).where(eq(conversations.id, input.conversationId));

  const [updatedConversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  const [insertedPart] = await db.select().from(parts).where(eq(parts.id, partId)).limit(1);

  return { conversation: updatedConversation!, part: insertedPart! };
}

/**
 * Reply-with-unsnooze-check: call this instead of a bare `appendPart(...,
 * {partType:'comment'})` from routes, so the snooze-asymmetry rule (assignee's
 * own reply does NOT unsnooze; anyone else's does) is enforced in one place.
 */
export async function appendReplyPart(
  db: Database,
  input: Omit<AppendPartInput, 'partType'> & { messageType: 'comment' | 'note' },
): Promise<AppendPartResult> {
  const { messageType, ...rest } = input;

  const [current] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  if (!current) throw new DeskConversationNotFoundError(input.conversationId);

  if (current.state !== 'snoozed' || messageType !== 'comment' || input.authorType === 'user') {
    // No snooze-interaction ambiguity: either not snoozed, or a note (which
    // never touches state), or a customer reply (always unsnoozes — handled
    // inside computeEffects for partType='comment').
    return appendPart(db, { ...rest, partType: messageType === 'note' ? 'note' : 'comment' });
  }

  // Snoozed + an admin/bot is replying. The assignee's OWN reply does not
  // unsnooze; anyone else's does (assign_and_unsnooze-style but via a plain
  // 'comment' + a following 'unsnoozed' event part).
  const staysSnoozed = !isDifferentFromAssignee(current, input.authorType, input.authorId);
  const result = await appendPart(db, { ...rest, partType: 'comment' });
  if (staysSnoozed) {
    // Restore the snoozed state/snoozedUntil that the plain 'comment' effect
    // didn't touch (comment doesn't change state for admin authors), so no
    // corrective part is needed — the conversation simply remains snoozed.
    return result;
  }

  return appendPart(db, {
    conversationId: input.conversationId,
    partType: 'unsnoozed',
    authorType: input.authorType,
    authorId: input.authorId,
    metadata: { reason: 'teammate_reply' },
  });
}

/**
 * Lazy timer-unsnooze: call from get/list reads. Flips a snoozed conversation
 * whose `snoozedUntil` has passed back to 'open' with a `timer_unsnooze`
 * part. TODO(phase-3): replace this lazy check with a Durable Object alarm
 * once the conversation DO lands, so snoozed conversations flip on time
 * rather than on next-read.
 */
export async function maybeTimerUnsnooze(
  db: Database,
  conversation: DeskConversation,
): Promise<DeskConversation> {
  if (conversation.state !== 'snoozed' || !conversation.snoozedUntil) return conversation;
  if (conversation.snoozedUntil.getTime() > Date.now()) return conversation;

  const { conversation: updated } = await appendPart(db, {
    conversationId: conversation.id,
    partType: 'timer_unsnooze',
    authorType: 'bot',
    metadata: { reason: 'snooze_timer_expired' },
  });
  return updated;
}

export type { DeskConversationAiAgent };
