/**
 * Widget Conversations Routes
 *
 * Allows customers to create and view conversations via the helpdesk widget.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { generateId } from '../lib/id';
import { success, error } from '../lib/response';
import { insertAuditLog } from '../lib/audit';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { notifyAgentsOfEscalation } from '../services/push-notifications';
import { publishEntityEvent } from '../lib/entity-events';
// TriggerConfig/EntityEventTriggerConfig no longer needed — welcome workflow
// extraction moved to the SSE endpoint (routes/workflow-stream.ts)

// ============================================================================
// Schemas
// ============================================================================

const welcomeMessageSchema = z.object({
  content: z.string(),
  sender: z.enum(['agent', 'customer']),
  senderName: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const createConversationSchema = z.object({
  subject: z.string().min(1).max(500),
  customerEmail: z.string().email().nullish(),
  customerName: z.string().nullish(),
  visitorId: z.string().max(100).nullish(),
  initialMessage: z.string().nullish(),
  website: z.string().max(500).nullish(),
  /** Welcome preview messages to persist (bot prompts + customer form responses) */
  welcomeMessages: z.array(welcomeMessageSchema).nullish(),
});

// ============================================================================
// Routes
// ============================================================================

export const conversationsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST / - Create a new conversation
 *
 * Allows a customer to start a new chat conversation.
 */
conversationsRoutes.post('/', zValidator('json', createConversationSchema), async (c) => {
  const workspaceId = c.get('workspaceId');
  const widgetId = c.get('widgetId');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations, helpdeskConversationMessages } = schema;

    const conversationId = generateId('conv');
    const conversationNumber = `CONV-${Date.now().toString(36).toUpperCase()}`;
    const now = new Date();

    // Extract visitor location from Cloudflare's geolocation data
    const cf = c.req.raw.cf;
    const visitorLocation = cf ? {
      country: cf.country as string | undefined,
      city: cf.city as string | undefined,
      region: cf.region as string | undefined,
      timezone: cf.timezone as string | undefined,
    } : undefined;


    // Auto-create or resolve contact
    let contactId: string | null = null;
    try {
      const { contacts } = schema;

      // 1. Try to find existing contact by email
      if (data.customerEmail) {
        const contactMatch = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.email, data.customerEmail), isNull(contacts.deletedAt)))
          .limit(1);
        if (contactMatch.length > 0) {
          contactId = contactMatch[0].id;

          // Update visitorId on existing contact if we have one (links email-identified contact to this browser)
          if (data.visitorId && contactMatch[0].id) {
            await db.update(contacts)
              .set({ visitorId: data.visitorId, updatedAt: now })
              .where(eq(contacts.id, contactMatch[0].id));
          }
        }
      }

      // 2. Try to find existing contact by visitorId (anonymous returning visitor)
      if (!contactId && data.visitorId) {
        const visitorMatch = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.visitorId, data.visitorId), isNull(contacts.deletedAt)))
          .limit(1);
        if (visitorMatch.length > 0) {
          contactId = visitorMatch[0].id;

          // Update email on existing contact if we now have one
          if (data.customerEmail) {
            await db.update(contacts)
              .set({ email: data.customerEmail, updatedAt: now })
              .where(eq(contacts.id, visitorMatch[0].id));
          }
        }
      }

      // 3. Create new contact if no match found
      if (!contactId) {
        contactId = generateId('cont');
        const customerName = data.customerName || (data.customerEmail ? data.customerEmail.split('@')[0] : 'Guest');
        const nameParts = customerName.split(' ');
        await db.insert(contacts).values({
          id: contactId,
          firstName: nameParts[0] || customerName,
          lastName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : '',
          fullName: customerName,
          email: data.customerEmail || null,
          visitorId: data.visitorId || null,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch {
      // contacts table may not exist yet
    }

    // Create the conversation
    // Note: workspaceId removed - tenant DB is already workspace-scoped
    await db.insert(helpdeskConversations).values({
      id: conversationId,
      conversationNumber,
      subject: data.subject,
      status: 'active',
      channel: 'chat',
      customerEmail: data.customerEmail || null,
      customerName: data.customerName || (data.customerEmail ? data.customerEmail.split('@')[0] : 'Guest'),
      contactId,
      messageCount: data.initialMessage ? 1 : 0,
      unreadCount: data.initialMessage ? 1 : 0,
      isRead: false,
      isStarred: false,
      isArchived: false,
      hasAttachments: false,
      tags: [],
      metadata: data.website ? { website: data.website } : undefined,
      visitorLocation,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: data.initialMessage ? now : null,
      lastCustomerMessageAt: data.initialMessage ? now : null,
    });

    // Create initial message if provided
    let messageId: string | undefined;
    if (data.initialMessage) {
      messageId = generateId('msg');

      await db.insert(helpdeskConversationMessages).values({
        id: messageId,
        conversationId,
        authorId: contactId || 'anonymous',
        authorName: data.customerName || (data.customerEmail ? data.customerEmail.split('@')[0] : 'Guest'),
        authorEmail: data.customerEmail || null,
        authorType: 'customer',
        content: data.initialMessage,
        type: 'message',
        isPublic: true,
        isInternal: false,
        status: 'sent',
        isRead: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Persist welcome preview messages and collect them for the response
    const persistedMessages: Array<{
      id: string;
      conversationId: string;
      content: string;
      authorType: string;
      authorName: string;
      metadata: Record<string, unknown> | undefined;
      createdAt: string;
    }> = [];

    if (data.welcomeMessages && data.welcomeMessages.length > 0) {
      for (let idx = 0; idx < data.welcomeMessages.length; idx++) {
        const msg = data.welcomeMessages[idx];
        const isCustomer = msg.sender === 'customer';
        const msgTime = new Date(now.getTime() - (data.welcomeMessages.length - idx) * 1000);
        const msgId = generateId('msg');

        await db.insert(helpdeskConversationMessages).values({
          id: msgId,
          conversationId,
          content: msg.content,
          authorType: isCustomer ? 'customer' : 'agent',
          authorId: isCustomer ? (contactId || 'anonymous') : 'workflow',
          authorName: isCustomer
            ? (data.customerName || 'Customer')
            : (msg.senderName || 'Bot'),
          type: 'message',
          isPublic: true,
          status: 'sent',
          isRead: false,
          metadata: msg.metadata || (isCustomer ? undefined : { source: 'welcome_preview', isBot: true }),
          createdAt: msgTime,
          updatedAt: now,
        });

        // Collect for response so widget can load them immediately
        persistedMessages.push({
          id: msgId,
          conversationId,
          content: msg.content,
          authorType: isCustomer ? 'customer' : 'agent',
          authorName: isCustomer ? (data.customerName || 'Customer') : (msg.senderName || 'Bot'),
          metadata: msg.metadata || (isCustomer ? undefined : { source: 'welcome_preview', isBot: true }),
          createdAt: msgTime.toISOString(),
        });
      }
    }

    console.log(`[Widget] Created conversation ${conversationId} for widget ${widgetId}`);

    // Welcome messages and workflow execution are now handled by the SSE endpoint:
    // POST /api/conversations/:id/workflow-stream?trigger=created
    // The widget opens an SSE connection right after creating the conversation.
    // This eliminates the CF Workflow roundtrip for customer-facing steps.

    // Agent notifications are deferred until the workflow-stream completes.
    // This avoids notifying agents when an AI is handling the conversation
    // or when the widget is still collecting customer info.

    return success(c, {
      id: conversationId,
      conversationNumber,
      subject: data.subject,
      status: 'active',
      customerEmail: data.customerEmail || null,
      customerName: data.customerName || (data.customerEmail ? data.customerEmail.split('@')[0] : 'Guest'),
      contactId,
      createdAt: now.toISOString(),
      // Persisted welcome messages with real DB IDs — widget loads them immediately
      messages: persistedMessages,
    }, 201);
  } catch (err) {
    console.error('[Widget] Failed to create conversation:', err);
    return error.internal(c, 'Failed to create conversation');
  }
});

/**
 * POST /bulk - Fetch multiple conversations by IDs
 *
 * Returns conversation summaries with current status for all matching IDs.
 * Used by the widget to check which stored conversations are still active.
 */
conversationsRoutes.post('/bulk', zValidator('json', z.object({
  conversationIds: z.array(z.string()).max(50),
})), async (c) => {
  const { conversationIds } = c.req.valid('json');
  if (conversationIds.length === 0) return success(c, []);

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations } = schema;
    const { inArray } = await import('drizzle-orm');

    const results = await db
      .select({
        id: helpdeskConversations.id,
        status: helpdeskConversations.status,
        subject: helpdeskConversations.subject,
        customerName: helpdeskConversations.customerName,
        lastMessage: helpdeskConversations.lastMessage,
        lastMessageAt: helpdeskConversations.lastMessageAt,
        messageCount: helpdeskConversations.messageCount,
        assigneeName: helpdeskConversations.assigneeName,
        createdAt: helpdeskConversations.createdAt,
      })
      .from(helpdeskConversations)
      .where(and(
        inArray(helpdeskConversations.id, conversationIds),
        isNull(helpdeskConversations.deletedAt),
      ));

    return success(c, results.map((conv) => ({
      id: conv.id,
      status: conv.status,
      subject: conv.subject,
      customerName: conv.customerName,
      lastMessage: conv.lastMessage,
      lastMessageAt: conv.lastMessageAt?.toISOString() || null,
      messageCount: conv.messageCount,
      assigneeName: conv.assigneeName,
      createdAt: conv.createdAt?.toISOString() || null,
    })));
  } catch (err) {
    console.error('[Widget] Failed to bulk fetch conversations:', err);
    return error.internal(c, 'Failed to fetch conversations');
  }
});

/**
 * GET /:id - Get a conversation by ID
 *
 * Returns conversation details for the customer.
 * Validates that the conversation belongs to the widget's workspace.
 */
conversationsRoutes.get('/:id', async (c) => {
  const workspaceId = c.get('workspaceId');
  const conversationId = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations } = schema;

    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const results = await db
      .select()
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.id, conversationId),
          isNull(helpdeskConversations.deletedAt)
        )
      )
      .limit(1);

    if (results.length === 0) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    const conv = results[0];

    // Return limited customer-facing data
    // Ticket fields are now on the conversation directly (isTicket, ticketNumber)
    return success(c, {
      id: conv.id,
      conversationNumber: conv.conversationNumber,
      subject: conv.subject,
      status: conv.status,
      customerEmail: conv.customerEmail,
      customerName: conv.customerName,
      contactId: conv.contactId || null,
      assigneeId: conv.assigneeId,
      assigneeName: conv.assigneeName,
      assigneeAvatar: conv.assigneeAvatar,
      messageCount: conv.messageCount,
      lastMessageAt: conv.lastMessageAt?.toISOString() || null,
      createdAt: conv.createdAt?.toISOString(),
      ticketNumber: conv.ticketNumber || null,
      ticketStatus: conv.isTicket ? conv.status : null,
    });
  } catch (err) {
    console.error('[Widget] Failed to fetch conversation:', err);
    return error.internal(c, 'Failed to fetch conversation');
  }
});

/**
 * GET /contact/:contactId - Get conversations for a contact
 *
 * Returns all conversations for a specific contact ID.
 */
conversationsRoutes.get('/contact/:contactId', async (c) => {
  const workspaceId = c.get('workspaceId');
  const contactId = c.req.param('contactId');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations } = schema;

    const results = await db
      .select()
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.contactId, contactId),
          isNull(helpdeskConversations.deletedAt)
        )
      )
      .orderBy(schema.helpdeskConversations.createdAt);

    const conversations = results.map((conv) => ({
      id: conv.id,
      conversationNumber: conv.conversationNumber,
      subject: conv.subject,
      status: conv.status,
      preview: conv.preview,
      messageCount: conv.messageCount,
      lastMessageAt: conv.lastMessageAt?.toISOString() || null,
      createdAt: conv.createdAt?.toISOString(),
    }));

    return success(c, conversations);
  } catch (err) {
    console.error('[Widget] Failed to fetch customer conversations:', err);
    return error.internal(c, 'Failed to fetch conversations');
  }
});

/**
 * GET /contact/:contactId - Get conversations for a contact
 *
 * Returns all conversations linked to a specific contact ID.
 * This is the preferred way to fetch a visitor's conversation history.
 */
conversationsRoutes.get('/contact/:contactId', async (c) => {
  const contactId = c.req.param('contactId');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations } = schema;

    const results = await db
      .select()
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.contactId, contactId),
          isNull(helpdeskConversations.deletedAt)
        )
      )
      .orderBy(schema.helpdeskConversations.createdAt);

    const conversations = results.map((conv) => ({
      id: conv.id,
      conversationNumber: conv.conversationNumber,
      subject: conv.subject,
      status: conv.status,
      preview: conv.preview,
      messageCount: conv.messageCount,
      lastMessageAt: conv.lastMessageAt?.toISOString() || null,
      createdAt: conv.createdAt?.toISOString(),
    }));

    return success(c, conversations);
  } catch (err) {
    console.error('[Widget] Failed to fetch contact conversations:', err);
    return error.internal(c, 'Failed to fetch conversations');
  }
});

/**
 * GET /resolve-contact - Resolve a contact ID from visitorId or email
 *
 * Used by the widget to find the contact for a returning visitor.
 */
conversationsRoutes.get('/resolve-contact', async (c) => {
  const visitorId = c.req.query('visitorId');
  const email = c.req.query('email');

  if (!visitorId && !email) {
    return error.badRequest(c, 'Either visitorId or email is required');
  }

  try {
    const db = c.get('tenantDb');
    const { contacts } = schema;

    let contactMatch: { id: string }[] = [];

    // Try email first
    if (email) {
      contactMatch = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.email, email), isNull(contacts.deletedAt)))
        .limit(1);
    }

    // Fall back to visitorId
    if (contactMatch.length === 0 && visitorId) {
      contactMatch = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.visitorId, visitorId), isNull(contacts.deletedAt)))
        .limit(1);
    }

    if (contactMatch.length === 0) {
      return success(c, { contactId: null });
    }

    return success(c, { contactId: contactMatch[0].id });
  } catch (err) {
    console.error('[Widget] Failed to resolve contact:', err);
    return error.internal(c, 'Failed to resolve contact');
  }
});

/**
 * PATCH /:id - Update conversation (close, reopen)
 *
 * Allows customers to close their conversations.
 */
const updateConversationSchema = z.object({
  status: z.enum(['active', 'closed']).optional(),
});

conversationsRoutes.patch('/:id', zValidator('json', updateConversationSchema), async (c) => {
  const workspaceId = c.get('workspaceId');
  const conversationId = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations } = schema;

    // Verify conversation exists
    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const existing = await db
      .select({ id: helpdeskConversations.id })
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.id, conversationId),
          isNull(helpdeskConversations.deletedAt)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    const updateData: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (data.status) {
      updateData.status = data.status;
    }

    await db
      .update(helpdeskConversations)
      .set(updateData)
      .where(eq(helpdeskConversations.id, conversationId));

    console.log(`[Widget] Updated conversation ${conversationId} status to ${data.status}`);

    // Publish entity event for conversation update
    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: conversationId,
      action: 'updated',
      data: {
        id: conversationId,
        ...updateData,
      },
    });

    return success(c, {
      id: conversationId,
      status: data.status,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Widget] Failed to update conversation:', err);
    return error.internal(c, 'Failed to update conversation');
  }
});

/**
 * PATCH /:id/customer-email - Update customer email
 *
 * Updates the conversation's customerEmail and the linked contact's email.
 */
const updateCustomerEmailSchema = z.object({
  email: z.string().email(),
});

conversationsRoutes.patch('/:id/customer-email', zValidator('json', updateCustomerEmailSchema), async (c) => {
  const conversationId = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations, contacts } = schema;

    // Verify conversation exists
    const existing = await db
      .select({ id: helpdeskConversations.id, contactId: helpdeskConversations.contactId })
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.id, conversationId),
          isNull(helpdeskConversations.deletedAt)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    // Resolve contact first, then update conversation with the correct name
    let resolvedContactId = existing[0].contactId;
    const nameFromEmail = data.email.split('@')[0];
    const nameParts = nameFromEmail.split(/[._-]/);
    const firstName = nameParts[0] ? nameParts[0].charAt(0).toUpperCase() + nameParts[0].slice(1) : nameFromEmail;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ') : '';
    const fullName = lastName ? `${firstName} ${lastName}` : firstName;

    // Will be updated to the matched contact's name if one is found
    let resolvedCustomerName = fullName;

    if (resolvedContactId) {
      try {
        // Check if another contact already has this email — if so, re-link instead of updating
        const existingByEmail = await db
          .select({ id: contacts.id, fullName: contacts.fullName })
          .from(contacts)
          .where(and(eq(contacts.email, data.email), isNull(contacts.deletedAt)))
          .limit(1);

        if (existingByEmail.length > 0 && existingByEmail[0].id !== resolvedContactId) {
          // Re-link conversation to the existing contact with this email
          resolvedContactId = existingByEmail[0].id;
          if (existingByEmail[0].fullName) {
            resolvedCustomerName = existingByEmail[0].fullName;
          }
        } else if (existingByEmail.length === 0) {
          // No other contact has this email — update the linked contact
          const [contact] = await db
            .select({ fullName: contacts.fullName })
            .from(contacts)
            .where(eq(contacts.id, resolvedContactId))
            .limit(1);

          const updateFields: Record<string, unknown> = { email: data.email, updatedAt: new Date() };
          if (!contact?.fullName || contact.fullName === 'Guest') {
            updateFields.firstName = firstName;
            updateFields.lastName = lastName;
            updateFields.fullName = fullName;
          } else {
            resolvedCustomerName = contact.fullName;
          }

          await db
            .update(contacts)
            .set(updateFields)
            .where(eq(contacts.id, resolvedContactId));
        } else {
          // existingByEmail[0].id === resolvedContactId → already correct
          if (existingByEmail[0].fullName) {
            resolvedCustomerName = existingByEmail[0].fullName;
          }
        }
      } catch {
        // contacts table may not exist yet
      }
    } else {
      // No contact linked — check for existing contact by email before creating
      try {
        const existingByEmail = await db
          .select({ id: contacts.id, fullName: contacts.fullName })
          .from(contacts)
          .where(and(eq(contacts.email, data.email), isNull(contacts.deletedAt)))
          .limit(1);

        if (existingByEmail.length > 0) {
          // Link existing contact instead of creating a duplicate
          resolvedContactId = existingByEmail[0].id;
          if (existingByEmail[0].fullName) {
            resolvedCustomerName = existingByEmail[0].fullName;
          }
        } else {
          // No existing contact — create new one
          const newContactId = generateId('cont');
          await db.insert(contacts).values({
            id: newContactId,
            firstName,
            lastName,
            fullName,
            email: data.email,
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          resolvedContactId = newContactId;
        }
      } catch {
        // contacts table may not exist yet
      }
    }

    // Update conversation with email, resolved name, and contact link
    await db
      .update(helpdeskConversations)
      .set({
        contactId: resolvedContactId,
        updatedAt: new Date(),
      })
      .where(eq(helpdeskConversations.id, conversationId));

    console.log(`[Widget] Updated customer email for conversation ${conversationId} to ${data.email}`);

    // Notify platform agents in real-time about the email update
    try {
      await new RealtimePublisher(c.env.REALTIME!).conversationSystem(conversationId, 'conversation_updated', {
        fields: {
          contactId: resolvedContactId,
          // Include resolved name/email for real-time UI updates (derived from contact)
          customerName: resolvedCustomerName,
          customerEmail: data.email,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (realtimeErr) {
      console.error('[Widget] Failed to publish conversation update:', realtimeErr);
    }

    return success(c, {
      conversationId,
      email: data.email,
    });
  } catch (err) {
    console.error('[Widget] Failed to update customer email:', err);
    return error.internal(c, 'Failed to update customer email');
  }
});

/**
 * POST /:id/typing - Send typing indicator
 *
 * Notifies that the customer is typing by publishing via @weldsuite/realtime.
 */
const typingSchema = z.object({
  isTyping: z.boolean(),
  customerName: z.string().optional(),
});

conversationsRoutes.post('/:id/typing', zValidator('json', typingSchema), async (c) => {
  const conversationId = c.req.param('id');
  const data = c.req.valid('json');

  // Rate-limit typing:start events (max 1 per 2s per conversation via KV)
  // typing:stop events always pass through so the UI clears the indicator promptly
  if (data.isTyping) {
    const kvKey = `typing:${conversationId}`;
    const existing = await c.env.WORKSPACE_CACHE.get(kvKey);
    if (existing) {
      // Already published a typing:start recently — skip to avoid spamming the realtime channel
      return success(c, { conversationId, isTyping: data.isTyping });
    }
    // Mark this conversation as actively typing with a short TTL
    c.executionCtx.waitUntil(
      c.env.WORKSPACE_CACHE.put(kvKey, '1', { expirationTtl: 2 })
    );
  }

  try {
    await new RealtimePublisher(c.env.REALTIME!).conversationPublish(conversationId, {
      type: 'typing',
      userId: 'customer',
      userName: data.customerName || 'Customer',
      isTyping: data.isTyping,
    });
  } catch (err) {
    console.error('[Widget] Failed to publish typing indicator:', err);
  }

  return success(c, {
    conversationId,
    isTyping: data.isTyping,
  });
});

/**
 * POST /:id/rate - Rate a conversation
 *
 * Allows customers to rate their conversation experience.
 */
const rateConversationSchema = z.object({
  rating: z.number().min(1).max(5),
  feedback: z.string().max(1000).optional(),
});

conversationsRoutes.post('/:id/rate', zValidator('json', rateConversationSchema), async (c) => {
  const workspaceId = c.get('workspaceId');
  const conversationId = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations, helpdeskReviews } = schema;

    // Verify conversation exists and get customer info
    const existing = await db
      .select()
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.id, conversationId),
          isNull(helpdeskConversations.deletedAt)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    const conversation = existing[0];
    const reviewId = generateId('rev');
    const now = new Date();

    // Store the review in the reviews table
    await db.insert(helpdeskReviews).values({
      id: reviewId,
      type: 'support',
      status: 'approved',
      rating: data.rating,
      title: `Conversation rating`,
      content: data.feedback || '',
      reviewerId: conversation.contactId || 'anonymous',
      reviewerName: conversation.customerName || 'Customer',
      reviewerEmail: conversation.customerEmail || '',
      conversationId,
      isVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    console.log(`[Widget] Conversation ${conversationId} rated ${data.rating}/5, review ${reviewId} created`);

    // Publish entity event for review creation
    publishEntityEvent({
      c,
      entityType: 'helpdesk_review',
      entityId: reviewId,
      action: 'created',
      data: {
        id: reviewId,
        type: 'support',
        rating: data.rating,
        feedback: data.feedback || '',
        conversationId,
        reviewerId: conversation.contactId || 'anonymous',
        reviewerName: conversation.customerName || 'Customer',
      },
    });

    return success(c, {
      conversationId,
      reviewId,
      rating: data.rating,
      message: 'Thank you for your feedback!',
    }, 201);
  } catch (err) {
    console.error('[Widget] Failed to rate conversation:', err);
    return error.internal(c, 'Failed to submit rating');
  }
});

/**
 * POST /:id/escalate - Request escalation to human agent
 *
 * Called by the widget when a customer accepts the AI's suggestion
 * to speak with a human agent. Updates the conversation in DB,
 * publishes real-time events, and sends push notifications.
 */
const escalateSchema = z.object({
  reason: z.string().max(1000).optional(),
});

conversationsRoutes.post('/:id/escalate', zValidator('json', escalateSchema), async (c) => {
  const workspaceId = c.get('workspaceId');
  const conversationId = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { helpdeskConversations, helpdeskConversationMessages } = schema;

    // Verify conversation exists
    const existing = await db
      .select()
      .from(helpdeskConversations)
      .where(
        and(
          eq(helpdeskConversations.id, conversationId),
          isNull(helpdeskConversations.deletedAt)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    const conversation = existing[0];
    const now = new Date();
    const escalatedAt = now.toISOString();

    // Update conversation: high priority, add 'escalated' tag, set status to 'pending'
    const currentTags = (conversation.tags as string[]) || [];
    const updatedTags = currentTags.includes('escalated') ? currentTags : [...currentTags, 'escalated'];

    await db
      .update(helpdeskConversations)
      .set({
        priority: 'high',
        tags: updatedTags,
        status: 'pending',
        assigneeId: null,
        assigneeName: null,
        updatedAt: now,
      })
      .where(eq(helpdeskConversations.id, conversationId));

    // Insert system message
    const systemMessageId = generateId('msg');
    const systemMessageContent = 'Customer requested to speak with a human agent';

    await db.insert(helpdeskConversationMessages).values({
      id: systemMessageId,
      conversationId,
      authorId: 'system',
      authorName: 'System',
      authorType: 'system',
      content: systemMessageContent,
      type: 'system',
      isPublic: true,
      isInternal: false,
      status: 'sent',
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });

    console.log(`[Widget] Conversation ${conversationId} escalated to human agent`);

    const escalationData = {
      conversationId,
      reason: data.reason,
      escalatedAt,
      customerName: conversation.customerName || undefined,
      customerEmail: conversation.customerEmail || undefined,
      subject: conversation.subject || undefined,
    };

    // Publish escalation events to both conversation and workspace channels
    try {
      const realtime = new RealtimePublisher(c.env.REALTIME!);
      await realtime.conversationSystem(conversationId, 'conversation_escalated', escalationData);
      await realtime.helpdeskEvent(workspaceId, 'conversation_escalated', escalationData);

      // Also publish the system message to conversation channel
      await realtime.conversationMessage(conversationId, {
        id: systemMessageId,
        content: systemMessageContent,
        senderId: 'system',
        senderName: 'System',
        senderType: 'agent',
      });
    } catch (realtimeErr) {
      console.error('[Widget] Failed to publish escalation:', realtimeErr);
    }

    // Send push notifications to agents (fire-and-forget)
    c.executionCtx.waitUntil(
      notifyAgentsOfEscalation(db, {
        conversationId,
        customerName: conversation.customerName || undefined,
        subject: conversation.subject || undefined,
        reason: data.reason,
      }, c.env.FIREBASE_SERVICE_ACCOUNT).catch((err) => console.error('[Push] Escalation notification error:', err))
    );

    // Publish entity event for conversation update
    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: conversationId,
      action: 'updated',
      data: {
        id: conversationId,
        priority: 'high',
        tags: updatedTags,
        status: 'pending',
        escalatedAt,
      },
    });

    // Audit log for customer-initiated escalation
    c.executionCtx.waitUntil(
      insertAuditLog(db, {
        entityType: 'helpdesk_conversation',
        entityId: conversationId,
        action: 'escalated',
        description: 'Customer requested escalation to human agent',
        changes: {
          status: { from: conversation.status, to: 'pending' },
          priority: { from: conversation.priority, to: 'high' },
        },
        performedBy: 'customer',
        performedByName: conversation.customerName || 'Customer',
        metadata: { reason: data.reason },
      })
    );

    return success(c, {
      conversationId,
      status: 'escalated',
      escalatedAt,
    });
  } catch (err) {
    console.error('[Widget] Failed to escalate conversation:', err);
    return error.internal(c, 'Failed to escalate conversation');
  }
});
