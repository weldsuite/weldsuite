/**
 * Conversation event reader.
 *
 * Ported from api-worker `src/services/helpdesk/conversation-events.ts`
 * (W5b legacy-worker phase-out).
 *
 * Only the read half is carried over. The legacy module also exported
 * `recordConversationEvent`, but the conversations route imported it without
 * ever calling it — the writers of `helpdesk_conversation_events` live in the
 * widget/workflow workers, which are untouched by this port. Reintroduce the
 * writer here only when an app-api route actually needs to record an event.
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '../../db';

export interface GetConversationEventsOptions {
  /** Exact event type, or a prefix such as `assignment.`. */
  eventType?: string;
  isPublic?: boolean;
  limit?: number;
}

/** Fetch a conversation's events, oldest first. */
export async function getConversationEvents(
  db: Database,
  conversationId: string,
  options?: GetConversationEventsOptions,
) {
  const { helpdeskConversationEvents } = schema;

  let query = db
    .select()
    .from(helpdeskConversationEvents)
    .where(eq(helpdeskConversationEvents.conversationId, conversationId))
    .orderBy(helpdeskConversationEvents.createdAt);

  if (options?.limit) {
    query = query.limit(options.limit) as typeof query;
  }

  const events = await query;

  // Post-filters, matching legacy semantics (eventType matches exactly or as a
  // dotted prefix). Kept client-side so the ported behaviour is identical.
  let filtered = events;
  if (options?.eventType) {
    const prefix = options.eventType;
    filtered = filtered.filter((e) => e.eventType === prefix || e.eventType.startsWith(prefix));
  }
  if (options?.isPublic !== undefined) {
    filtered = filtered.filter((e) => e.isPublic === options.isPublic);
  }

  return filtered;
}
