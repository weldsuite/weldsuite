/**
 * Widget Messages Routes
 *
 * Allows customers to view and send messages in conversations.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull, sql, inArray, ne, gt } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { generateId } from '../lib/id';
import { success, error } from '../lib/response';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { notifyAgentsOfNewMessage } from '../services/push-notifications';
import { publishEntityEvent } from '../lib/entity-events';

// ============================================================================
// Schemas
// ============================================================================

// Attachment schema for incoming messages
const attachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  url: z.string(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  customerId: z.string().nullish(), // Optional - will use conversation's customerId if not provided
  customerName: z.string().optional(),
  customerEmail: z.string().email().nullish(),
  attachments: z.array(attachmentSchema).max(5).optional(),
});

// ============================================================================
// Routes
// ============================================================================

export const messagesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /unread-count - Get unread message count across conversations
 *
 * Returns the count of unread agent/system messages for the given conversation IDs.
 */
messagesRoutes.get('/unread-count', async (c) => {
  const ids = c.req.query('conversationIds')?.split(',').filter(Boolean) || [];
  if (ids.length === 0) return success(c, { count: 0 });

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversationMessages } = schema;

    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(helpdeskConversationMessages)
      .where(and(
        inArray(helpdeskConversationMessages.conversationId, ids),
        ne(helpdeskConversationMessages.authorType, 'customer'),
        eq(helpdeskConversationMessages.isRead, false),
        eq(helpdeskConversationMessages.isPublic, true),
        isNull(helpdeskConversationMessages.deletedAt)
      ));

    return success(c, { count: Number(result[0]?.count || 0) });
  } catch (err) {
    console.error('[Widget] Failed to fetch unread count:', err);
    return error.internal(c, 'Failed to fetch unread count');
  }
});

/**
 * GET /:conversationId - Get messages for a conversation
 *
 * Returns all public messages in a conversation (excludes internal notes).
 */
messagesRoutes.get('/:conversationId', async (c) => {
  const workspaceId = c.get('workspaceId');
  const conversationId = c.req.param('conversationId');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations, helpdeskConversationMessages } = schema;

    // Verify conversation exists
    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const conversationExists = await db
      .select({ id: helpdeskConversations.id })
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.id, conversationId),
          isNull(helpdeskConversations.deletedAt)
        )
      )
      .limit(1);

    if (conversationExists.length === 0) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    // Incremental fetch: ?after=ISO timestamp returns only newer messages
    const afterParam = c.req.query('after');
    const afterDate = afterParam ? new Date(afterParam) : null;

    const conditions = [
      eq(helpdeskConversationMessages.conversationId, conversationId),
      eq(helpdeskConversationMessages.isPublic, true),
      isNull(helpdeskConversationMessages.deletedAt),
    ];

    if (afterDate && !isNaN(afterDate.getTime())) {
      conditions.push(gt(helpdeskConversationMessages.createdAt, afterDate));
    }

    const messages = await db
      .select()
      .from(helpdeskConversationMessages)
      .where(and(...conditions))
      .orderBy(helpdeskConversationMessages.createdAt, helpdeskConversationMessages.id);

    // Mark unread agent messages as read (customer is viewing them)
    const hasUnread = messages.some((msg) => msg.authorType !== 'customer' && !msg.isRead);

    if (hasUnread) {
      await db.update(helpdeskConversationMessages)
        .set({ isRead: true, readAt: new Date() })
        .where(
          and(
            eq(helpdeskConversationMessages.conversationId, conversationId),
            eq(helpdeskConversationMessages.isRead, false),
          )
        );

      // Notify agents that messages were read (fire-and-forget after response)
      c.executionCtx.waitUntil(
        new RealtimePublisher(c.env.REALTIME!).helpdeskEvent(workspaceId, 'conversation_read', {
          conversationId,
          timestamp: new Date().toISOString(),
        }).catch((err) => {
          console.error('[Widget] Failed to publish read notification:', err);
        })
      );
    }

    const formattedMessages = messages.map((msg) => ({
      id: msg.id,
      conversationId: msg.conversationId,
      authorId: msg.authorId,
      authorName: msg.authorName,
      authorType: msg.authorType,
      authorAvatar: msg.authorAvatar,
      content: msg.content,
      htmlContent: msg.htmlContent,
      type: msg.type,
      attachments: msg.attachments || [],
      metadata: msg.metadata || undefined,
      createdAt: msg.createdAt?.toISOString(),
    }));

    return success(c, formattedMessages);
  } catch (err) {
    console.error('[Widget] Failed to fetch messages:', err);
    return error.internal(c, 'Failed to fetch messages');
  }
});

/**
 * POST /:conversationId - Send a message in a conversation
 *
 * Single path for ALL customer messages (text, attachments, or both).
 * Handles: DB persistence, realtime publishing (Chat REST API + raw pub/sub),
 * workspace notifications, push notifications, and entity events.
 * Workflow triggering happens separately via the SSE workflow-stream endpoint.
 */
messagesRoutes.post('/:conversationId', zValidator('json', sendMessageSchema), async (c) => {
  const workspaceId = c.get('workspaceId');
  const conversationId = c.req.param('conversationId');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations, helpdeskConversationMessages } = schema;

    // Verify conversation exists
    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const conversationResults = await db
      .select()
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.id, conversationId),
          isNull(helpdeskConversations.deletedAt)
        )
      )
      .limit(1);

    if (conversationResults.length === 0) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    const conversation = conversationResults[0];

    // Use provided customerId or fall back to conversation's customerId
    const customerId = data.customerId || conversation.customerId;

    // Verify the customer ID matches if both are provided
    if (data.customerId && conversation.customerId && conversation.customerId !== data.customerId) {
      return error.forbidden(c, 'Customer ID does not match conversation');
    }

    const messageId = generateId('msg');
    const now = new Date();

    // Check if message has attachments
    const hasAttachments = data.attachments && data.attachments.length > 0;

    // Create the message
    // Note: workspaceId removed - tenant DB is already workspace-scoped
    await db.insert(helpdeskConversationMessages).values({
      id: messageId,
      conversationId,
      authorId: customerId,
      authorName: data.customerName || conversation.customerName || 'Customer',
      authorEmail: data.customerEmail || conversation.customerEmail,
      authorType: 'customer',
      content: data.content,
      type: 'message',
      isPublic: true,
      isInternal: false,
      status: 'sent',
      isRead: false,
      attachments: hasAttachments ? data.attachments : null,
      hasAttachments: hasAttachments || false,
      createdAt: now,
      updatedAt: now,
    });

    // Update conversation
    await db
      .update(helpdeskConversations)
      .set({
        lastMessage: data.content.substring(0, 500),
        preview: data.content.substring(0, 200),
        lastMessageAt: now,
        lastCustomerMessageAt: now,
        messageCount: sql`${helpdeskConversations.messageCount} + 1`,
        unreadCount: sql`${helpdeskConversations.unreadCount} + 1`,
        isRead: false,
        status: conversation.status === 'resolved' || conversation.status === 'closed' ? 'active' : conversation.status,
        updatedAt: now,
      })
      .where(eq(helpdeskConversations.id, conversationId));

    console.log(`[Widget] Message ${messageId} sent in conversation ${conversationId}`);

    // Publish to realtime for real-time updates to agents
    try {
      const realtime = new RealtimePublisher(c.env.REALTIME!);
      await realtime.conversationMessage(conversationId, {
        id: messageId,
        content: data.content,
        senderId: customerId || 'unknown',
        senderName: data.customerName || conversation.customerName || 'Customer',
        senderType: 'customer',
        attachments: data.attachments?.map(a => ({ id: a.id, name: a.fileName, url: a.url, type: a.mimeType, size: a.fileSize })),
      });

      // Also notify workspace channel so sidebar badges update
      await realtime.helpdeskEvent(workspaceId, 'message_new', {
        conversationId,
        preview: data.content.substring(0, 200),
        senderName: data.customerName || conversation.customerName || 'Customer',
      });
    } catch (realtimeErr) {
      // Log but don't fail the request if realtime publish fails
      console.error('[Widget] Failed to publish message:', realtimeErr);
    }

    // First customer message: notify agents that a new conversation exists.
    // Makes the conversation visible in the agent inbox.
    const isFirstMessage = (conversation.messageCount ?? 0) === 0;
    if (isFirstMessage) {
      try {
        await new RealtimePublisher(c.env.REALTIME!).helpdeskEvent(workspaceId, 'conversation_new', {
          conversationId,
          subject: conversation.subject || 'New conversation',
          customerName: data.customerName || conversation.customerName,
          customerEmail: data.customerEmail || conversation.customerEmail || undefined,
          preview: data.content.substring(0, 200),
          channel: conversation.channel || 'chat',
          createdAt: conversation.createdAt?.toISOString() || now.toISOString(),
        });
      } catch (err) {
        console.warn('[Widget] Failed to publish new conversation notification:', err);
      }
    }

    // Send push notifications to agents
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await notifyAgentsOfNewMessage(db, {
            conversationId,
            senderName: data.customerName || conversation.customerName || 'Customer',
            preview: data.content.substring(0, 200),
          }, c.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (err) {
          console.error('[Push] Fire-and-forget error:', err);
        }
      })()
    );

    // Publish entity event for analytics, audit logs, and platform data-events bridge
    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation_message',
      entityId: messageId,
      action: 'created',
      data: {
        id: messageId,
        conversationId,
        authorId: customerId,
        authorName: data.customerName || conversation.customerName || 'Customer',
        authorType: 'customer',
        content: data.content,
        hasAttachments: hasAttachments || false,
      },
    });

    return success(c, {
      id: messageId,
      conversationId,
      authorId: customerId,
      authorName: data.customerName || conversation.customerName || 'Customer',
      authorType: 'customer',
      content: data.content,
      createdAt: now.toISOString(),
    }, 201);
  } catch (err) {
    console.error('[Widget] Failed to send message:', err);
    return error.internal(c, 'Failed to send message');
  }
});

/**
 * POST /:messageId/respond - Respond to an interactive workflow message
 *
 * Handles customer responses to send_choices and collect_input workflow steps.
 */
const respondSchema = z.union([
  z.object({ type: z.literal('choice'), optionId: z.string(), value: z.string() }),
  z.object({ type: z.literal('input'), data: z.record(z.string()) }),
  z.object({ type: z.literal('csat'), rating: z.number().min(1).max(5), feedback: z.string().optional() }),
]);

messagesRoutes.post('/:messageId/respond', zValidator('json', respondSchema), async (c) => {
  const workspaceId = c.get('workspaceId');
  const messageId = c.req.param('messageId');
  const response = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversationMessages, helpdeskConversations } = schema;

    // Fetch the message
    const messageResults = await db
      .select()
      .from(helpdeskConversationMessages)
      .where(eq(helpdeskConversationMessages.id, messageId))
      .limit(1);

    if (messageResults.length === 0) {
      return error.notFound(c, 'Message', messageId);
    }

    const message = messageResults[0];
    const metadata = (message.metadata || {}) as Record<string, unknown>;

    // Validate this is an interactive message
    if (!metadata.interactiveType) {
      return error.badRequest(c, 'Message is not an interactive workflow message');
    }

    // Check if already responded
    if (metadata.respondedAt) {
      return error.badRequest(c, 'Message has already been responded to');
    }

    const now = new Date();

    // Update message metadata with the response
    let updatedMetadata: Record<string, unknown>;
    let followUpContent: string;

    if (response.type === 'choice') {
      const options = (metadata.options as Array<{ id: string; label: string; value: string }>) || [];
      const selected = options.find((o) => o.id === response.optionId);
      updatedMetadata = {
        ...metadata,
        selectedOptionId: response.optionId,
        respondedAt: now.toISOString(),
      };
      followUpContent = selected?.label || response.value;
    } else if (response.type === 'input') {
      updatedMetadata = {
        ...metadata,
        submittedData: response.data,
        respondedAt: now.toISOString(),
      };
      // Summarize submitted fields
      const entries = Object.entries(response.data);
      followUpContent = entries.map(([key, val]) => `${key}: ${val}`).join(', ');
    } else if (response.type === 'csat') {
      updatedMetadata = {
        ...metadata,
        submittedRating: response.rating,
        submittedFeedback: response.feedback,
        respondedAt: now.toISOString(),
      };
      followUpContent = `Rated ${response.rating}/5${response.feedback ? ': ' + response.feedback : ''}`;

      // Update the satisfaction survey record
      const surveyId = metadata.surveyId as string | undefined;
      if (surveyId) {
        try {
          await db
            .update(schema.helpdeskSatisfactionSurveys)
            .set({
              rating: response.rating,
              comment: response.feedback || null,
              status: 'completed',
              respondedAt: now,
              updatedAt: now,
            })
            .where(eq(schema.helpdeskSatisfactionSurveys.id, surveyId));
        } catch (err) {
          console.error('[Widget] Failed to update satisfaction survey:', err);
        }
      }
    } else {
      return error.badRequest(c, 'Unknown response type');
    }

    // Update the interactive message metadata
    await db
      .update(helpdeskConversationMessages)
      .set({ metadata: updatedMetadata, updatedAt: now })
      .where(eq(helpdeskConversationMessages.id, messageId));

    // If the submitted data contains an email, update conversation + contact
    if (response.type === 'input' && response.data.email) {
      const submittedEmail = response.data.email;
      const submittedName = response.data.name;
      const { helpdeskConversations, contacts } = schema;

      // Update conversation
      const nameFromEmail = submittedName || submittedEmail.split('@')[0];
      await db
        .update(helpdeskConversations)
        .set({ customerEmail: submittedEmail, customerName: nameFromEmail, updatedAt: now })
        .where(eq(helpdeskConversations.id, message.conversationId));

      // Update or create contact
      try {
        const [conv] = await db
          .select({ contactId: helpdeskConversations.contactId })
          .from(helpdeskConversations)
          .where(eq(helpdeskConversations.id, message.conversationId))
          .limit(1);

        const nameParts = nameFromEmail.split(/[._\-\s]/);
        const firstName = nameParts[0] ? nameParts[0].charAt(0).toUpperCase() + nameParts[0].slice(1) : nameFromEmail;
        const lastName = nameParts.length > 1 ? nameParts.slice(1).map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ') : '';
        const fullName = lastName ? `${firstName} ${lastName}` : firstName;

        if (conv?.contactId) {
          const [contact] = await db
            .select({ fullName: contacts.fullName })
            .from(contacts)
            .where(eq(contacts.id, conv.contactId))
            .limit(1);

          const updateFields: Record<string, unknown> = { email: submittedEmail, updatedAt: now };
          if (!contact?.fullName || contact.fullName === 'Guest') {
            updateFields.firstName = firstName;
            updateFields.lastName = lastName;
            updateFields.fullName = fullName;
          }
          await db.update(contacts).set(updateFields).where(eq(contacts.id, conv.contactId));
        } else {
          const newContactId = generateId('cont');
          await db.insert(contacts).values({
            id: newContactId,
            firstName,
            lastName,
            fullName,
            email: submittedEmail,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          });
          await db
            .update(helpdeskConversations)
            .set({ contactId: newContactId, updatedAt: now })
            .where(eq(helpdeskConversations.id, message.conversationId));
        }
      } catch {
        // contacts table may not exist
      }
    }

    // Insert a follow-up customer message showing the selection
    const followUpId = generateId('msg');
    await db.insert(helpdeskConversationMessages).values({
      id: followUpId,
      conversationId: message.conversationId,
      authorId: 'customer',
      authorName: 'Customer',
      authorType: 'customer',
      content: followUpContent,
      type: 'message',
      isPublic: true,
      isInternal: false,
      status: 'sent',
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });

    // Publish follow-up message via realtime
    try {
      await new RealtimePublisher(c.env.REALTIME!).conversationMessage(message.conversationId, {
        id: followUpId,
        content: followUpContent,
        senderId: 'customer',
        senderName: 'Customer',
        senderType: 'customer',
      });
    } catch (realtimeErr) {
      console.error('[Widget] Failed to publish follow-up message:', realtimeErr);
    }

    // Workflow resume is handled by the widget via SSE:
    // After respondToMessage(), the widget calls startWorkflowStream(conversationId, 'resume', {...})
    // which opens an SSE connection to workflow-stream.ts and calls engine.resume() with SSE streaming.
    // This allows AI token streaming to reach the widget in real-time.

    return success(c, { success: true });
  } catch (err) {
    console.error('[Widget] Failed to respond to message:', err);
    return error.internal(c, 'Failed to respond to message');
  }
});
