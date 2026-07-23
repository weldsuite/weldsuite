/**
 * Helpdesk WeldAgent routes — /api/helpdesk-weldagent/* surface.
 * Conversation record-keeping for conversations previously handled by AI.
 *
 * NOTE: This file does not itself call any AI provider or service binding —
 * it only persists conversation rows. The AI streaming chat preview endpoint
 * (/chat) was never migrated here and no longer exists anywhere; AI has been
 * physically removed from WeldSuite. `helpdeskSettings.weldagentConfig` (the
 * JSONB column that used to back GET/POST /config) has been dropped along
 * with every other AI table, so /config now returns a static disabled shape
 * and no longer touches the database.
 *
 * Permissions: settings:read | settings:update | conversations:create | conversations:read | conversations:update.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// Schemas
// ============================================================================

const saveConfigSchema = z.object({
  name: z.string().max(50).optional(),
  logoUrl: z.string().max(500).optional().nullable(),
  systemInstructions: z.string().optional(),
  knowledgePermissions: z.record(z.boolean()).optional(),
  escalationSettings: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
  welcomeMessage: z.string().optional(),
  allowHumanEscalation: z.boolean().optional(),
  greetingMessage: z.string().optional(),
  agentDefinitionId: z.string().optional(),
  enabledBuiltinTools: z.array(z.string()).optional(),
  maxIterations: z.number().optional(),
  maxTotalTokens: z.number().optional(),
  onEscalation: z.enum(['assign_round_robin', 'assign_least_busy', 'notify_only']).optional(),
  onResolution: z.enum(['auto_close', 'mark_resolved', 'do_nothing']).optional(),
  onFailure: z.enum(['assign_and_apologize', 'notify_only']).optional(),
  apologyMessage: z.string().optional(),
});

const createAiConversationSchema = z.object({
  sessionId: z.string().min(1),
  customerEmail: z.string().email().optional(),
  customerName: z.string().optional(),
  conversationContext: z.record(z.unknown()).optional(),
});

const sendAiMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  role: z.enum(['user', 'assistant']).default('user'),
  metadata: z.record(z.unknown()).optional(),
});

const transferToHumanSchema = z.object({
  reason: z.string().max(1000),
  urgency: z.string().optional(),
});

const acceptEscalationSchema = z.object({
  agentId: z.string().min(1),
});

const convertToTicketSchema = z.object({
  subject: z.string().min(1).max(500),
  description: z.string().optional(),
  priority: z.string().optional(),
  category: z.string().optional(),
  assigneeId: z.string().optional(),
});

// ============================================================================
// GET /config, POST /config — WeldAgent configuration (REMOVED)
//
// Used to read/write `helpdeskSettings.weldagentConfig`, a JSONB column that
// has been dropped along with every other AI table. AI is no longer
// configurable; both endpoints now report unavailability without touching
// the database.
// ============================================================================

app.get('/config', requirePermission('settings:read'), async (c) => {
  return c.json({ error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } }, 503);
});

app.post('/config', requirePermission('settings:update'), zValidator('json', saveConfigSchema), async (c) => {
  return c.json({ error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } }, 503);
});

// ============================================================================
// AI Conversation Routes
// ============================================================================

app.post('/conversations', requirePermission('conversations:create'), zValidator('json', createAiConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskConversations } = schema;
  const data = c.req.valid('json');
  const conversationId = generateId('conv');
  const conversationNumber = `CONV-${Date.now().toString(36).toUpperCase()}`;
  const now = new Date();
  try {
    await db.insert(helpdeskConversations).values({
      id: conversationId,
      conversationNumber,
      subject: 'AI Conversation',
      status: 'active',
      channel: 'chat',
      customerEmail: data.customerEmail ?? null,
      customerName: data.customerName ?? 'Visitor',
      assigneeId: 'ai-agent',
      assigneeName: 'WeldAgent',
      messageCount: 0,
      unreadCount: 0,
      isRead: true,
      isStarred: false,
      isArchived: false,
      hasAttachments: false,
      tags: ['ai-managed'],
      metadata: { sessionId: data.sessionId, ...(data.conversationContext ?? {}) },
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof helpdeskConversations.$inferInsert);
    publishEntityEvent({ c, entityType: 'helpdesk_conversation', entityId: conversationId, action: 'created', data: { id: conversationId, conversationNumber } });
    return success(c, { id: conversationId, conversationNumber, subject: 'AI Conversation', status: 'active', assigneeId: 'ai-agent', createdAt: now.toISOString() }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-weldagent] create conversation failed:', err);
    return error.internal(c, 'Failed to create AI conversation');
  }
});

app.get('/conversations/ai-active', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskConversations } = schema;
  const page = Number(c.req.query('page') || '1');
  const pageSize = Math.min(Number(c.req.query('pageSize') || '25'), 100);
  const search = c.req.query('search') ?? '';
  try {
    const conditions = [
      isNull(helpdeskConversations.deletedAt),
      eq(helpdeskConversations.assigneeId, 'ai-agent'),
      sql`${helpdeskConversations.status} IN ('active', 'pending')`,
    ];
    if (search) {
      const term = `%${search}%`;
      conditions.push(sql`(${helpdeskConversations.subject} ILIKE ${term} OR ${helpdeskConversations.customerName} ILIKE ${term} OR ${helpdeskConversations.customerEmail} ILIKE ${term})`);
    }
    const [countRes] = await db.select({ count: sql<number>`count(*)::int` }).from(helpdeskConversations).where(and(...conditions));
    const totalCount = countRes?.count ?? 0;
    const results = await db.select().from(helpdeskConversations).where(and(...conditions)).orderBy(desc(helpdeskConversations.updatedAt)).limit(pageSize).offset((page - 1) * pageSize);
    return success(c, { conversations: results, pagination: { page, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize) } });
  } catch (err) {
    console.error('[app-api/helpdesk-weldagent] list ai-active conversations failed:', err);
    return error.internal(c, 'Failed to fetch active AI conversations');
  }
});

app.get('/conversations/ai-resolved', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskConversations } = schema;
  const page = Number(c.req.query('page') || '1');
  const pageSize = Math.min(Number(c.req.query('pageSize') || '25'), 100);
  const search = c.req.query('search') ?? '';
  try {
    const conditions = [
      isNull(helpdeskConversations.deletedAt),
      eq(helpdeskConversations.assigneeId, 'ai-agent'),
      sql`${helpdeskConversations.status} IN ('resolved', 'closed')`,
    ];
    if (search) {
      const term = `%${search}%`;
      conditions.push(sql`(${helpdeskConversations.subject} ILIKE ${term} OR ${helpdeskConversations.customerName} ILIKE ${term} OR ${helpdeskConversations.customerEmail} ILIKE ${term})`);
    }
    const [countRes] = await db.select({ count: sql<number>`count(*)::int` }).from(helpdeskConversations).where(and(...conditions));
    const totalCount = countRes?.count ?? 0;
    const results = await db.select().from(helpdeskConversations).where(and(...conditions)).orderBy(desc(helpdeskConversations.updatedAt)).limit(pageSize).offset((page - 1) * pageSize);
    const aiResolved = results.filter((conv) => !((conv.tags as string[]) ?? []).includes('escalated'));
    return success(c, { conversations: aiResolved, pagination: { page, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize) } });
  } catch (err) {
    console.error('[app-api/helpdesk-weldagent] list ai-resolved conversations failed:', err);
    return error.internal(c, 'Failed to fetch AI-resolved conversations');
  }
});

app.get('/conversations/pending', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskConversations } = schema;
  try {
    const results = await db
      .select()
      .from(helpdeskConversations)
      .where(and(eq(helpdeskConversations.status, 'pending'), isNull(helpdeskConversations.deletedAt)))
      .orderBy(desc(helpdeskConversations.updatedAt));
    const escalated = results.filter((conv) => ((conv.tags as string[]) ?? []).includes('escalated'));
    return success(c, escalated);
  } catch (err) {
    console.error('[app-api/helpdesk-weldagent] list pending conversations failed:', err);
    return error.internal(c, 'Failed to fetch pending escalations');
  }
});

app.get('/conversations/:id', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskConversations, helpdeskConversationMessages } = schema;
  const conversationId = c.req.param('id');
  try {
    const [conversation] = await db.select().from(helpdeskConversations).where(and(eq(helpdeskConversations.id, conversationId), isNull(helpdeskConversations.deletedAt))).limit(1);
    if (!conversation) return error.notFound(c, 'Conversation', conversationId);
    const messages = await db.select().from(helpdeskConversationMessages).where(and(eq(helpdeskConversationMessages.conversationId, conversationId), isNull(helpdeskConversationMessages.deletedAt))).orderBy(helpdeskConversationMessages.createdAt);
    return success(c, { ...conversation, messages });
  } catch (err) {
    console.error('[app-api/helpdesk-weldagent] get conversation failed:', err);
    return error.internal(c, 'Failed to fetch AI conversation');
  }
});

app.post('/conversations/:id/messages', requirePermission('conversations:update'), zValidator('json', sendAiMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskConversations, helpdeskConversationMessages } = schema;
  const conversationId = c.req.param('id');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const now = new Date();
  try {
    const [conversation] = await db.select().from(helpdeskConversations).where(and(eq(helpdeskConversations.id, conversationId), isNull(helpdeskConversations.deletedAt))).limit(1);
    if (!conversation) return error.notFound(c, 'Conversation', conversationId);
    const messageId = generateId('msg');
    await db.insert(helpdeskConversationMessages).values({
      id: messageId,
      conversationId,
      authorId: userId,
      authorName: data.role === 'user' ? 'User' : 'WeldAgent',
      authorType: data.role === 'user' ? 'customer' : 'agent',
      content: data.content,
      type: 'message',
      isPublic: true,
      isInternal: false,
      status: 'sent',
      isRead: false,
      metadata: data.metadata,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof helpdeskConversationMessages.$inferInsert);
    await db.update(helpdeskConversations).set({ lastMessage: data.content.substring(0, 500), preview: data.content.substring(0, 200), lastMessageAt: now, messageCount: sql`${helpdeskConversations.messageCount} + 1`, updatedAt: now }).where(eq(helpdeskConversations.id, conversationId));
    publishEntityEvent({ c, entityType: 'helpdesk_conversation_message', entityId: messageId, action: 'created', data: { id: messageId, conversationId, authorId: userId, authorType: data.role === 'user' ? 'customer' : 'agent', content: data.content } });
    return success(c, { id: messageId, conversationId, content: data.content, role: data.role, createdAt: now.toISOString() }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-weldagent] send message failed:', err);
    return error.internal(c, 'Failed to send message');
  }
});

app.post('/conversations/:id/transfer-to-human', requirePermission('conversations:update'), zValidator('json', transferToHumanSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskConversations, helpdeskConversationMessages } = schema;
  const conversationId = c.req.param('id');
  const data = c.req.valid('json');
  const now = new Date();
  try {
    const [conversation] = await db.select().from(helpdeskConversations).where(and(eq(helpdeskConversations.id, conversationId), isNull(helpdeskConversations.deletedAt))).limit(1);
    if (!conversation) return error.notFound(c, 'Conversation', conversationId);
    const currentTags = (conversation.tags as string[]) ?? [];
    const updatedTags = currentTags.includes('escalated') ? currentTags : [...currentTags, 'escalated'];
    await db.update(helpdeskConversations).set({ status: 'pending', priority: data.urgency === 'urgent' ? 'urgent' : 'high', tags: updatedTags, updatedAt: now }).where(eq(helpdeskConversations.id, conversationId));
    const systemMessageId = generateId('msg');
    await db.insert(helpdeskConversationMessages).values({ id: systemMessageId, conversationId, authorId: 'system', authorName: 'System', authorType: 'system', content: `Conversation transferred to human agent. Reason: ${data.reason}`, type: 'system', isPublic: true, isInternal: false, status: 'sent', isRead: false, createdAt: now, updatedAt: now } as unknown as typeof helpdeskConversationMessages.$inferInsert);
    publishEntityEvent({ c, entityType: 'helpdesk_conversation', entityId: conversationId, action: 'escalated', data: { id: conversationId, status: 'pending' } });
    return success(c, { conversationId, status: 'pending', escalatedAt: now.toISOString() });
  } catch (err) {
    console.error('[app-api/helpdesk-weldagent] transfer to human failed:', err);
    return error.internal(c, 'Failed to transfer to human agent');
  }
});

app.post('/conversations/:id/accept', requirePermission('conversations:update'), zValidator('json', acceptEscalationSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskConversations } = schema;
  const conversationId = c.req.param('id');
  const { agentId } = c.req.valid('json');
  const now = new Date();
  try {
    const [conversation] = await db.select().from(helpdeskConversations).where(and(eq(helpdeskConversations.id, conversationId), isNull(helpdeskConversations.deletedAt))).limit(1);
    if (!conversation) return error.notFound(c, 'Conversation', conversationId);
    await db.update(helpdeskConversations).set({ assigneeId: agentId, status: 'active', updatedAt: now }).where(eq(helpdeskConversations.id, conversationId));
    publishEntityEvent({ c, entityType: 'helpdesk_conversation', entityId: conversationId, action: 'assigned', data: { id: conversationId, assigneeId: agentId } });
    return success(c, { conversationId, assigneeId: agentId, status: 'active', acceptedAt: now.toISOString() });
  } catch (err) {
    console.error('[app-api/helpdesk-weldagent] accept escalation failed:', err);
    return error.internal(c, 'Failed to accept escalation');
  }
});

app.post('/conversations/:id/convert-to-ticket', requirePermission('conversations:update'), zValidator('json', convertToTicketSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskConversations, helpdeskTickets } = schema;
  const conversationId = c.req.param('id');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const now = new Date();
  try {
    const [conversation] = await db.select().from(helpdeskConversations).where(and(eq(helpdeskConversations.id, conversationId), isNull(helpdeskConversations.deletedAt))).limit(1);
    if (!conversation) return error.notFound(c, 'Conversation', conversationId);
    const ticketId = generateId('tkt');
    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;
    await db.insert(helpdeskTickets).values({
      id: ticketId,
      ticketNumber,
      subject: data.subject,
      description: data.description ?? (conversation.lastMessage as string | undefined) ?? '',
      status: 'new',
      priority: data.priority ?? 'medium',
      category: data.category ?? null,
      channel: 'chat',
      customerEmail: conversation.customerEmail,
      customerName: conversation.customerName,
      assigneeId: data.assigneeId ?? null,
      reporterId: userId,
      tags: ['from-ai-conversation'],
      metadata: { sourceConversationId: conversationId },
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof helpdeskTickets.$inferInsert);
    await db.update(helpdeskConversations).set({ status: 'closed', updatedAt: now }).where(eq(helpdeskConversations.id, conversationId));
    publishEntityEvent({ c, entityType: 'helpdesk_ticket', entityId: ticketId, action: 'created', data: { id: ticketId, ticketNumber, subject: data.subject, status: 'new', priority: data.priority ?? 'medium' } });
    return success(c, { ticketId, ticketNumber, subject: data.subject, status: 'new', priority: data.priority ?? 'medium', conversationId, createdAt: now.toISOString() }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-weldagent] convert to ticket failed:', err);
    return error.internal(c, 'Failed to convert conversation to ticket');
  }
});

export const helpdeskWeldagentRoutes = app;
