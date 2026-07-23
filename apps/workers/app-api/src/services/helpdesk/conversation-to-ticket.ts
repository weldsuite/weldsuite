/**
 * WeldDesk conversation → ticket linking.
 *
 * Extracted from `routes/tickets/index.ts` so the two doors onto the same
 * operation share one implementation:
 *   - `POST /api/tickets { conversationId }` — the WeldDesk ticket form.
 *   - `POST /api/conversations/:id/convert-to-ticket` — the inbox action.
 *
 * The `helpdesk_conversations.ticket_id` FK this used to hang off no longer
 * exists (tenant migration 0085 dropped the column), so the link is carried by
 * the system message's `metadata.ticketId`. api-worker still writes the dropped
 * column: in `POST /helpdesk/tickets` the throw is swallowed by a catch (taking
 * the system message and realtime event down with it), and in
 * `POST /helpdesk/conversations/:id/convert-to-ticket` it escapes as a 500 —
 * after the ticket row has already been inserted. Both are avoided here by
 * simply not attempting the impossible write.
 *
 * Pure-ish: takes `env` rather than a Hono context, so it stays callable from
 * either route without dragging the request in.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type { Env } from '../../types';

const cm = schema.helpdeskConversationMessages;
const tm = schema.helpdeskTicketMessages;

export interface LinkConversationToTicketInput {
  conversationId: string;
  ticketId: string;
  ticketNumber: string;
  subject: string;
  priority?: string;
  customerName: string;
  /**
   * Required, not optional: `helpdesk_ticket_messages.author_email` is NOT
   * NULL, and a conversation message may carry no author email of its own,
   * so this is the fallback that keeps the copied row insertable.
   */
  customerEmail: string;
  contactId?: string | null;
  now: Date;
}

/**
 * Attach a freshly created ticket to the conversation it was raised from:
 * copy the public transcript onto the ticket, drop a system message into the
 * conversation, and fan the link out over realtime.
 *
 * Non-fatal by design (as in api-worker): a ticket that was created must not
 * fail the request because its conversation could not be annotated.
 */
export async function linkConversationToTicket(
  env: Env,
  db: Database,
  args: LinkConversationToTicketInput,
): Promise<void> {
  const {
    conversationId,
    ticketId,
    ticketNumber,
    subject,
    priority,
    customerName,
    customerEmail,
    contactId,
    now,
  } = args;

  // 1. Copy the public transcript onto the ticket.
  try {
    const convMessages = await db
      .select()
      .from(cm)
      .where(and(eq(cm.conversationId, conversationId), eq(cm.isPublic, true), isNull(cm.deletedAt)))
      .orderBy(asc(cm.createdAt));

    if (convMessages.length > 0) {
      await db.insert(tm).values(
        convMessages.map((msg) => ({
          id: generateId('tkm'),
          ticketId,
          body: msg.content,
          htmlBody: msg.htmlContent,
          authorType: msg.authorType || 'customer',
          authorId: msg.authorId || contactId || 'unknown',
          authorName: msg.authorName || customerName || 'Customer',
          authorEmail: msg.authorEmail || customerEmail,
          isInternal: false,
          createdAt: msg.createdAt || now,
          updatedAt: msg.updatedAt || now,
        })),
      );
    }
  } catch (err) {
    console.error('[app-api/helpdesk] failed to copy conversation messages:', err);
  }

  // 2. Annotate the conversation + fan out.
  try {
    await db.insert(cm).values({
      id: generateId('cvm'),
      conversationId,
      authorId: 'system',
      authorName: 'System',
      authorType: 'system',
      content: `Ticket created: ${subject}`,
      type: 'system',
      isPublic: true,
      isInternal: false,
      isRead: false,
      metadata: {
        ticketId,
        ticketNumber,
        ticketSubject: subject,
        ticketStatus: 'open',
        ticketPriority: priority,
      },
      createdAt: now,
      updatedAt: now,
    });

    if (env.REALTIME) {
      await new RealtimePublisher(env.REALTIME).conversationSystem(conversationId, 'ticket_linked', {
        text: `Ticket created: ${subject}`,
        ticketId,
        ticketNumber,
        ticketSubject: subject,
        ticketStatus: 'open',
        ticketPriority: priority,
      });
    }
  } catch (err) {
    console.error('[app-api/helpdesk] failed to link conversation to ticket:', err);
  }
}
