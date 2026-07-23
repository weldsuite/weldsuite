/**
 * Widget Open Route
 *
 * Single POST endpoint that returns everything the widget needs on open:
 * config, welcome workflow parts, team agents, contact, conversations, unread count.
 * Replaces 5+ individual HTTP requests with one.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull, ne, inArray, desc, sql } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { success, error } from '../lib/response';
import { fetchWidgetBaseData, buildWidgetConfigResponse } from '../lib/widget-config';
import type { HelpdeskWorkflowStep as WorkflowStep, HelpdeskTriggerConfig as TriggerConfig, HelpdeskEntityEventTriggerConfig as EntityEventTriggerConfig } from '@weldsuite/db/schema/helpdesk-workflow-types';

// ============================================================================
// Schema
// ============================================================================

const openSchema = z.object({
  visitorId: z.string().max(100).nullish(),
  email: z.string().email().nullish(),
  customerName: z.string().max(255).nullish(),
  url: z.string().max(2000).nullish(),
});

// ============================================================================
// Route
// ============================================================================

export const openRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

openRoutes.post('/', zValidator('json', openSchema), async (c) => {
  const data = c.req.valid('json');
  const widgetConfig = c.get('widgetConfig');
  const db = c.get('tenantDb');

  try {
    // ========================================================================
    // Phase 1: Parallel queries (no dependencies)
    // ========================================================================

    const [baseData, agentsResult, contactResult, workflowsResult] = await Promise.all([
      // Q1+Q2: helpdeskSettings + helpdeskDepartments (parallel inside)
      fetchWidgetBaseData(db),

      // Q3: helpdeskAgents (status='active', limit 10)
      db
        .select({
          id: schema.helpdeskAgents.id,
          name: schema.helpdeskAgents.name,
          avatar: schema.helpdeskAgents.avatar,
          isOnline: schema.helpdeskAgents.isOnline,
        })
        .from(schema.helpdeskAgents)
        .where(
          and(
            eq(schema.helpdeskAgents.status, 'active'),
            isNull(schema.helpdeskAgents.deletedAt)
          )
        )
        .limit(10),

      // Q4: contacts (resolve by email → visitorId)
      resolveContact(db, data.email ?? null, data.visitorId ?? null),

      // Q5: helpdeskWorkflows (active, for greeting workflow)
      db
        .select({
          id: schema.helpdeskWorkflows.id,
          triggers: schema.helpdeskWorkflows.triggers,
          steps: schema.helpdeskWorkflows.steps,
        })
        .from(schema.helpdeskWorkflows)
        .where(
          and(
            eq(schema.helpdeskWorkflows.status, 'active'),
            isNull(schema.helpdeskWorkflows.deletedAt)
          )
        ),
    ]);

    // ========================================================================
    // Build config (same shape as GET /api/config, minus welcome/welcomeFlow)
    // ========================================================================

    const { settings, defaultDepartment } = baseData;

    const config = buildWidgetConfigResponse(
      widgetConfig,
      settings,
      defaultDepartment,
      c.get('removeBranding')
    );

    // ========================================================================
    // Extract welcome workflow parts
    // ========================================================================

    const welcomeWorkflow = extractWelcomeWorkflow(workflowsResult);

    // ========================================================================
    // Build team info
    // ========================================================================

    const agents = agentsResult.map((a) => ({
      id: a.id,
      name: a.name,
      avatar: a.avatar || null,
      isOnline: a.isOnline ?? false,
    }));
    const onlineCount = agents.filter((a) => a.isOnline).length;

    const team = {
      agents,
      onlineCount,
    };

    // ========================================================================
    // Phase 2: Conversations (depends on contact resolution)
    // ========================================================================

    let conversations: Array<{
      id: string;
      conversationNumber: string | null;
      subject: string | null;
      status: string | null;
      preview: string | null;
      messageCount: number | null;
      unreadCount: number | null;
      lastMessageAt: string | null;
      assigneeName: string | null;
      assigneeAvatar: string | null;
      createdAt: string | null;
    }> = [];

    if (contactResult) {
      const convResults = await db
        .select({
          id: schema.helpdeskConversations.id,
          conversationNumber: schema.helpdeskConversations.conversationNumber,
          subject: schema.helpdeskConversations.subject,
          status: schema.helpdeskConversations.status,
          preview: schema.helpdeskConversations.preview,
          messageCount: schema.helpdeskConversations.messageCount,
          unreadCount: schema.helpdeskConversations.unreadCount,
          lastMessageAt: schema.helpdeskConversations.lastMessageAt,
          assigneeName: schema.helpdeskConversations.assigneeName,
          assigneeAvatar: schema.helpdeskConversations.assigneeAvatar,
          createdAt: schema.helpdeskConversations.createdAt,
        })
        .from(schema.helpdeskConversations)
        .where(
          and(
            eq(schema.helpdeskConversations.contactId, contactResult.contactId),
            isNull(schema.helpdeskConversations.deletedAt)
          )
        )
        .orderBy(desc(schema.helpdeskConversations.lastMessageAt))
        .limit(10);

      conversations = convResults.map((conv) => ({
        id: conv.id,
        conversationNumber: conv.conversationNumber,
        subject: conv.subject,
        status: conv.status,
        preview: conv.preview,
        messageCount: conv.messageCount,
        unreadCount: conv.unreadCount,
        lastMessageAt: conv.lastMessageAt?.toISOString() || null,
        assigneeName: conv.assigneeName,
        assigneeAvatar: conv.assigneeAvatar,
        createdAt: conv.createdAt?.toISOString() || null,
      }));
    }

    // ========================================================================
    // Phase 3: Unread count (depends on conversations)
    // ========================================================================

    let unreadCount = 0;

    const conversationIds = conversations.map((c) => c.id);
    if (conversationIds.length > 0) {
      const unreadResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.helpdeskConversationMessages)
        .where(
          and(
            inArray(schema.helpdeskConversationMessages.conversationId, conversationIds),
            ne(schema.helpdeskConversationMessages.authorType, 'customer'),
            eq(schema.helpdeskConversationMessages.isRead, false),
            eq(schema.helpdeskConversationMessages.isPublic, true),
            isNull(schema.helpdeskConversationMessages.deletedAt)
          )
        );

      unreadCount = Number(unreadResult[0]?.count || 0);
    }

    // ========================================================================
    // Return combined response
    // ========================================================================

    return success(c, {
      config,
      welcomeWorkflow,
      team,
      contact: contactResult,
      conversations,
      unreadCount,
    });
  } catch (err) {
    console.error('[Widget] /api/open error:', err);
    return error.internal(c, 'Failed to load widget data');
  }
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve contact by email first, then visitorId.
 */
async function resolveContact(
  db: any,
  email: string | null,
  visitorId: string | null
): Promise<{ contactId: string; email: string | null; name: string | null } | null> {
  if (!email && !visitorId) return null;

  const { contacts } = schema;

  try {
    // Try email first
    if (email) {
      const match = await db
        .select({ id: contacts.id, email: contacts.email, name: contacts.fullName })
        .from(contacts)
        .where(and(eq(contacts.email, email), isNull(contacts.deletedAt)))
        .limit(1);
      if (match.length > 0) {
        return { contactId: match[0].id, email: match[0].email, name: match[0].name };
      }
    }

    // Fall back to visitorId
    if (visitorId) {
      const match = await db
        .select({ id: contacts.id, email: contacts.email, name: contacts.fullName })
        .from(contacts)
        .where(and(eq(contacts.visitorId, visitorId), isNull(contacts.deletedAt)))
        .limit(1);
      if (match.length > 0) {
        return { contactId: match[0].id, email: match[0].email, name: match[0].name };
      }
    }
  } catch {
    // contacts table may not exist yet
  }

  return null;
}

/**
 * Extract welcome parts from the first workflow triggered by helpdesk_conversation:created.
 *
 * Walks the workflow steps and collects leading send_message / send_choices steps
 * until hitting a non-message step (condition, delay, ai_agent, etc.).
 */
function extractWelcomeWorkflow(
  workflows: Array<{
    id: string;
    triggers: TriggerConfig[] | null;
    steps: WorkflowStep[] | null;
  }>
): {
  workflowId: string;
  parts: Array<{
    stepId: string;
    type: 'send_message' | 'send_choices';
    message: string;
    options?: Array<{ id: string; label: string; value: string }>;
  }>;
  bot: { name: string; avatarUrl: string | null; isBot: boolean };
} | null {
  // Find first workflow with entity_event trigger on helpdesk_conversation:created
  for (const wf of workflows) {
    if (!wf.triggers || !wf.steps) continue;

    const hasConversationCreatedTrigger = wf.triggers.some((trigger) => {
      if (trigger.type !== 'entity_event' || !trigger.isEnabled) return false;
      const cfg = trigger.config as EntityEventTriggerConfig;
      return cfg.entityType === 'helpdesk_conversation' && cfg.eventType === 'created';
    });

    if (!hasConversationCreatedTrigger) continue;

    // Walk steps and collect leading message steps
    const parts: Array<{
      stepId: string;
      type: 'send_message' | 'send_choices';
      message: string;
      options?: Array<{ id: string; label: string; value: string }>;
    }> = [];

    // Sort steps by order if available
    const sortedSteps = [...wf.steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const step of sortedSteps) {
      if (step.type === 'send_message') {
        const message = (step.config?.message as string) || (step.inputs?.message as string) || '';
        if (message) {
          parts.push({ stepId: step.id, type: 'send_message', message });
        }
      } else if (step.type === 'send_choices') {
        const message = (step.config?.message as string) || (step.inputs?.message as string) || '';
        const options = ((step.config?.options || step.inputs?.options) as Array<{ id: string; label: string; value: string }>) || [];
        if (message) {
          parts.push({ stepId: step.id, type: 'send_choices', message, options });
        }
      } else {
        // Hit a non-message step — stop collecting
        break;
      }
    }

    if (parts.length === 0) continue;

    return {
      workflowId: wf.id,
      parts,
      bot: {
        name: 'Bot',
        avatarUrl: null,
        isBot: true,
      },
    };
  }

  return null;
}
