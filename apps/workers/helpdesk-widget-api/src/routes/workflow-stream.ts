/**
 * Workflow Trigger Endpoint — Inline execution with SSE streaming
 *
 * Executes all workflow steps directly — including AI with token streaming.
 * Returns SSE (text/event-stream) so the widget can receive AI tokens in real-time.
 *
 * POST /api/conversations/:id/workflow-stream
 *   ?trigger=created          — Conversation just created
 *   ?trigger=message_received — Customer sent a message
 *
 * POST /api/conversations/:id/workflow-stream?resume=true
 *   OR ?trigger=resume
 *   Resume from interactive step (choice selected, form submitted)
 *
 * SSE events:
 *   event: step          — Step completed (message, choices, etc.)
 *   event: ai_typing     — AI is generating a response
 *   event: ai_token      — Streaming AI token (partial content)
 *   event: ai_complete   — AI response finished
 *   event: done          — All steps completed, final result
 */

import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { executeWorkflowInline } from '../engine/inline-executor';
import { resumeWorkflowInline } from '../engine/resume-executor';

export const workflowStreamRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

workflowStreamRoutes.post('/:id/workflow-stream', async (c) => {
  const conversationId = c.req.param('id');
  const workspaceId = c.get('workspaceId');
  const trigger = c.req.query('trigger') || 'created';
  const resume = c.req.query('resume') === 'true' || trigger === 'resume';
  const db = c.get('tenantDb');

  // Validate conversation exists
  const [conversation] = await db
    .select()
    .from(schema.helpdeskConversations)
    .where(and(eq(schema.helpdeskConversations.id, conversationId), isNull(schema.helpdeskConversations.deletedAt)))
    .limit(1);

  if (!conversation) {
    return c.json({ success: false, error: 'Conversation not found' }, 404);
  }

  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch {}

  // Check Accept header — if client wants SSE, stream events
  const wantsSSE = c.req.header('accept')?.includes('text/event-stream');

  if (wantsSSE) {
    return streamSSE(c, db, conversationId, workspaceId, conversation, trigger, resume, body);
  }

  // JSON mode — execute and return result
  try {
    if (resume) {
      const result = await resumeWorkflowInline({
        db, env: c.env, conversationId, workspaceId,
        stepId: c.req.query('stepId') || (body.stepId as string) || '',
        selectedValue: (c.req.query('selectedValue') || body.selectedValue) as string | undefined,
        selectedLabel: body.selectedLabel as string | undefined,
        submittedData: body.submittedData as Record<string, string> | undefined,
        rating: body.rating as number | undefined,
        feedback: body.feedback as string | undefined,
      });
      return c.json({ success: true, ...result });
    }

    const eventType = trigger === 'created' ? 'conversation_created' : 'message_received';
    const result = await executeWorkflowInline({
      db, env: c.env, conversationId, workspaceId,
      eventType: eventType as 'conversation_created' | 'message_received',
      channel: (conversation.channel as string) || 'web',
      triggerData: buildTriggerData(conversation, body, trigger, conversationId, workspaceId),
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    console.error('[WorkflowStream] Error:', err);
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// ============================================================================
// SSE streaming mode
// ============================================================================

function streamSSE(
  c: any,
  db: any,
  conversationId: string,
  workspaceId: string,
  conversation: any,
  trigger: string,
  resume: boolean,
  body: Record<string, unknown>,
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: { event: string; data: Record<string, unknown> }) => {
        const sseEvent = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
        controller.enqueue(encoder.encode(sseEvent));
      };

      try {
        let result: any;

        if (resume) {
          result = await resumeWorkflowInline({
            db, env: c.env, conversationId, workspaceId,
            stepId: c.req.query('stepId') || (body.stepId as string) || '',
            selectedValue: (c.req.query('selectedValue') || body.selectedValue) as string | undefined,
            selectedLabel: body.selectedLabel as string | undefined,
            submittedData: body.submittedData as Record<string, string> | undefined,
            rating: body.rating as number | undefined,
            feedback: body.feedback as string | undefined,
            emit,
          });
        } else {
          const eventType = trigger === 'created' ? 'conversation_created' : 'message_received';
          result = await executeWorkflowInline({
            db, env: c.env, conversationId, workspaceId,
            eventType: eventType as 'conversation_created' | 'message_received',
            channel: (conversation.channel as string) || 'web',
            triggerData: buildTriggerData(conversation, body, trigger, conversationId, workspaceId),
            emit,
          });
        }

        // Final event
        emit({ event: 'done', data: { success: true, ...result } });
      } catch (err) {
        emit({ event: 'error', data: { error: (err as Error).message } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ============================================================================
// Helpers
// ============================================================================

function buildTriggerData(
  conversation: any,
  body: Record<string, unknown>,
  trigger: string,
  conversationId: string,
  workspaceId: string,
): Record<string, unknown> {
  return {
    channel: conversation.channel || 'web',
    metadata: conversation.metadata,
    subject: conversation.subject,
    status: conversation.status,
    customerName: conversation.customerName || body.customerName || 'Guest',
    customerEmail: conversation.customerEmail,
    priority: conversation.priority,
    conversationId,
    workspaceId,
    timestamp: new Date().toISOString(),
    ...(trigger === 'message_received' && body.messageContent
      ? { content: body.messageContent, messageId: body.messageId, authorType: 'customer', authorName: body.customerName || conversation.customerName || 'Customer' }
      : {}),
  };
}
