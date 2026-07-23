/**
 * Helpdesk Workflow Worker — Entry Point
 *
 * Workflow execution via CF Workflows + assignment routing via DO + SLA cron.
 *
 * Entry points:
 * 1. HTTP fetch: /event, /respond (workflow), /assign, /release, /sync-agents
 * 2. Cron scheduled: SLA breach detection (every minute)
 * 3. CF Workflow: ConversationWorkflow (step execution)
 */

import { AssignmentRouter } from './durable-objects/assignment-router';
import { ConversationWorkflow } from './workflows/conversation-workflow';
import { getMasterDb, getTenantDbForWorkspace } from './db';
import { checkSlaBreaches } from './lib/sla-breach-checker';
import { workspaces } from '@weldsuite/db/schema/master';
import { and, eq, isNotNull, isNull, inArray } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import type { Env, AssignRequest, AgentCapacity } from './types';
import type { ConversationWorkflowParams } from './workflows/conversation-workflow';

// Re-export for wrangler
export { AssignmentRouter, ConversationWorkflow };

// AI is currently unavailable — the Anthropic provider bootstrap has been
// removed. AI-backed steps (ai_auto_reply, ai_classify, ai_summarize,
// ai_translate, ai_sentiment) short-circuit at the handler level instead.

export default {
  // =========================================================================
  // HTTP
  // =========================================================================

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // ─── Workflow: trigger event ───
      if (url.pathname === '/event') {
        const body = await request.json() as {
          type: 'conversation_created' | 'message_received';
          conversationId: string;
          workspaceId: string;
          data: Record<string, unknown>;
        };

        const db = await getTenantDbForWorkspace(env, body.workspaceId);

        // Check for active execution — skip if already running
        const [activeExec] = await db
          .select({
            id: schema.helpdeskWorkflowExecutions.id,
            status: schema.helpdeskWorkflowExecutions.status,
            executionContext: schema.helpdeskWorkflowExecutions.executionContext,
          })
          .from(schema.helpdeskWorkflowExecutions)
          .where(
            and(
              eq(schema.helpdeskWorkflowExecutions.conversationId, body.conversationId),
              inArray(schema.helpdeskWorkflowExecutions.status, ['running', 'waiting_for_input', 'ai_active']),
            ),
          )
          .limit(1);

        // If AI is active and this is a new message, forward to the CF Workflow
        if (activeExec?.status === 'ai_active' && body.type === 'message_received') {
          try {
            // Find the CF Workflow instance by listing recent ones
            // CF Workflows are identified by instance ID — we use the conversation ID
            // to find the right one via the execution context
            const instances = env.CONVERSATION_WORKFLOW;

            // Send customer_message event to the workflow waiting in the AI loop
            // We need the instance ID — stored in execution context or use conversation-based lookup
            // For now, broadcast to the workflow binding (CF will route to the right instance)
            const execCtx = (activeExec as any).executionContext as Record<string, unknown> | null;
            const cfInstanceId = execCtx?.cfInstanceId as string | undefined;

            if (cfInstanceId) {
              const instance = await instances.get(cfInstanceId);
              await instance.sendEvent({
                type: 'customer_message',
                payload: {
                  content: body.data?.content || body.data?.messageContent,
                  customerName: body.data?.customerName || body.data?.authorName,
                  messageId: body.data?.messageId,
                },
              });
              return Response.json({ success: true, action: 'ai_message_sent' });
            }
          } catch (err) {
            console.error('[Event] Failed to forward to AI workflow:', err);
          }
          return Response.json({ success: true, action: 'busy' });
        }

        if (activeExec) {
          return Response.json({ success: true, action: 'busy' });
        }

        // Create CF Workflow instance
        const instance = await env.CONVERSATION_WORKFLOW.create({
          params: {
            workspaceId: body.workspaceId,
            conversationId: body.conversationId,
            eventType: body.type,
            channel: (body.data?.channel as string) || 'web',
            triggerData: {
              ...body.data,
              conversationId: body.conversationId,
              workspaceId: body.workspaceId,
              timestamp: new Date().toISOString(),
            },
          } satisfies ConversationWorkflowParams,
        });

        return Response.json({ success: true, action: 'workflow_started', instanceId: instance.id });
      }

      // ─── Workflow: resume from interactive step ───
      if (url.pathname === '/respond') {
        const body = await request.json() as {
          conversationId: string;
          workspaceId: string;
          executionId: string;
          stepId: string;
          selectedValue?: string;
          selectedLabel?: string;
          submittedData?: Record<string, string>;
          rating?: number;
          feedback?: string;
        };

        const db = await getTenantDbForWorkspace(env, body.workspaceId);

        // Find active execution to get the CF Workflow instance ID
        const [execution] = await db
          .select({
            id: schema.helpdeskWorkflowExecutions.id,
            executionContext: schema.helpdeskWorkflowExecutions.executionContext,
          })
          .from(schema.helpdeskWorkflowExecutions)
          .where(
            and(
              eq(schema.helpdeskWorkflowExecutions.conversationId, body.conversationId),
              eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
            ),
          )
          .limit(1);

        if (!execution) {
          return Response.json({ success: false, error: 'No waiting execution found' }, { status: 404 });
        }

        // Send event to the CF Workflow instance
        // The instance is waiting in step.waitForEvent('customer_response')
        // We need to find it — CF Workflows doesn't store instance IDs in our DB,
        // so we search by sending to the most recent instance for this conversation
        try {
          // List recent instances and find the running one
          // For now, send the response data that the workflow will pick up
          const instances = await env.CONVERSATION_WORKFLOW.get(body.conversationId);

          await instances.sendEvent({
            type: 'customer_response',
            payload: {
              stepId: body.stepId,
              selectedValue: body.selectedValue,
              selectedLabel: body.selectedLabel,
              submittedData: body.submittedData,
              rating: body.rating,
              feedback: body.feedback,
            },
          });

          return Response.json({ success: true, action: 'event_sent' });
        } catch (err) {
          console.error('[Respond] Failed to send event:', err);
          return Response.json({ success: false, error: (err as Error).message }, { status: 500 });
        }
      }

      // ─── Assignment router ───
      if (url.pathname === '/assign') {
        const body = await request.json() as AssignRequest;
        const doId = env.ASSIGNMENT_ROUTER.idFromName(body.departmentId);
        const stub = env.ASSIGNMENT_ROUTER.get(doId);
        const result = await (stub as any).assignConversation(body);
        return Response.json(result ?? { error: 'no_agents_available' });
      }

      if (url.pathname === '/release') {
        const body = await request.json() as { departmentId: string; agentId: string };
        const doId = env.ASSIGNMENT_ROUTER.idFromName(body.departmentId);
        const stub = env.ASSIGNMENT_ROUTER.get(doId);
        await (stub as any).releaseConversation(body.agentId);
        return Response.json({ ok: true });
      }

      if (url.pathname === '/sync-agents') {
        const body = await request.json() as { departmentId: string; agents: AgentCapacity[] };
        const doId = env.ASSIGNMENT_ROUTER.idFromName(body.departmentId);
        const stub = env.ASSIGNMENT_ROUTER.get(doId);
        await (stub as any).syncAgents(body.departmentId, body.agents);
        return Response.json({ ok: true });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error('[Fetch] Error:', err);
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  },

  // =========================================================================
  // Cron: SLA breach detection (every minute)
  // =========================================================================

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const masterDb = getMasterDb(env);

      const activeWorkspaces = await masterDb
        .select({ clerkOrgId: workspaces.clerkOrgId })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.isActive, true),
            isNotNull(workspaces.neonProjectId),
          ),
        );

      for (const ws of activeWorkspaces) {
        if (!ws.clerkOrgId) continue;
        ctx.waitUntil(
          (async () => {
            try {
              const tenantDb = await getTenantDbForWorkspace(env, ws.clerkOrgId!);
              const breachCount = await checkSlaBreaches(tenantDb as any, ws.clerkOrgId!);
              if (breachCount > 0) {
                console.log(`[SLA] ${ws.clerkOrgId}: ${breachCount} breaches detected`);
              }
            } catch (err) {
              console.error(`[SLA] Error for workspace ${ws.clerkOrgId}:`, err);
            }
          })(),
        );
      }
    } catch (err) {
      console.error('[SLA] Cron error:', err);
    }
  },
} satisfies ExportedHandler<Env>;
