/**
 * ConversationWorkflow — Cloudflare Workflow
 *
 * Executes helpdesk workflows triggered by conversation events.
 * Each step persists its output to the DB, then publishes a lightweight
 * "refetch" hint so the widget picks up new messages via DB query.
 *
 * Uses CF Workflows primitives:
 *   step.do()          — execute a handler + persist to DB
 *   step.waitForEvent() — pause for customer response (interactive steps)
 *   step.sleep()        — delay steps
 *
 * Follows the same pattern as api-worker/workflows/execute-workflow/index.ts.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull, or } from 'drizzle-orm';
import type { Env } from '../types';
import { getTenantDbForWorkspace, schema } from '../db';
import { generateId } from '../lib/id';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { resolveInputs, evaluateCondition, isInteractiveStep } from '../lib/workflow-shared';
import { executeStepHandler, type StepExecutionOptions } from './step-executor';
import { dispatchStepToChannel } from '../lib/channel-dispatch';

// ============================================================================
// Types
// ============================================================================

export interface ConversationWorkflowParams {
  workspaceId: string;
  conversationId: string;
  eventType: 'conversation_created' | 'message_received';
  channel: string;
  triggerData: Record<string, unknown>;
  /** Pre-matched workflow IDs — if provided, skip trigger matching */
  workflowIds?: string[];
}

interface WorkflowStepDef {
  id: string;
  name: string;
  type: string;
  order?: number;
  inputs?: Record<string, unknown>;
  config?: Record<string, unknown>;
  condition?: { field?: string; operator?: string; value?: unknown };
  continueOnError?: boolean;
  parentBranchId?: string;
}

// ============================================================================
// Workflow
// ============================================================================

export class ConversationWorkflow extends WorkflowEntrypoint<Env, ConversationWorkflowParams> {
  async run(event: WorkflowEvent<ConversationWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const rt = this.env.REALTIME ? new RealtimePublisher(this.env.REALTIME) : null;

    // ------------------------------------------------------------------
    // Step 1: Match triggers and load workflow definitions
    // ------------------------------------------------------------------
    const matchResult = await step.do('match-triggers', async () => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);

      const workflows = await db
        .select({
          id: schema.helpdeskWorkflows.id,
          name: schema.helpdeskWorkflows.name,
          steps: schema.helpdeskWorkflows.steps,
          triggers: schema.helpdeskWorkflows.triggers,
          sortOrder: schema.helpdeskWorkflows.sortOrder,
        })
        .from(schema.helpdeskWorkflows)
        .where(
          and(
            eq(schema.helpdeskWorkflows.status, 'active'),
            isNull(schema.helpdeskWorkflows.deletedAt),
          ),
        )
        .orderBy(schema.helpdeskWorkflows.sortOrder);

      // Match triggers by event type
      // Workflows can use different trigger configs:
      //   conversation_created → entityType: 'helpdesk_conversation', eventType: 'created'
      //   message_received → entityType: 'helpdesk_conversation', eventType: 'message_received'
      //                   OR entityType: 'helpdesk_conversation_message', eventType: 'created'
      const matched = workflows.filter((wf) => {
        if (params.workflowIds?.length) {
          return params.workflowIds.includes(wf.id);
        }

        const triggers = (wf.triggers || []) as Array<{
          type: string;
          isEnabled?: boolean;
          config?: { entityType?: string; eventType?: string; channels?: string[] };
        }>;

        return triggers.some((t) => {
          if (!t.isEnabled || t.type !== 'entity_event') return false;
          const cfg = t.config;
          if (!cfg) return false;

          // Match based on our event type
          if (params.eventType === 'conversation_created') {
            // Must match: entity=helpdesk_conversation, event=created
            if (cfg.entityType !== 'helpdesk_conversation') return false;
            if (cfg.eventType && cfg.eventType !== 'created') return false;
          } else if (params.eventType === 'message_received') {
            // Accept any of these common trigger patterns:
            // 1. entity=helpdesk_conversation, event=message_received
            // 2. entity=helpdesk_conversation_message, event=created
            // 3. entity=helpdesk_conversation, event=first_message
            const isConvMessage = cfg.entityType === 'helpdesk_conversation' &&
              (cfg.eventType === 'message_received' || cfg.eventType === 'first_message');
            const isMsgCreated = cfg.entityType === 'helpdesk_conversation_message' &&
              (!cfg.eventType || cfg.eventType === 'created');
            if (!isConvMessage && !isMsgCreated) return false;
          }

          // Channel filter
          if (cfg.channels?.length && !cfg.channels.includes(params.channel)) return false;
          return true;
        });
      });

      // Log for debugging
      console.log(`[match-triggers] eventType=${params.eventType}, matched=${matched.length}/${workflows.length}`);
      for (const wf of workflows) {
        const triggers = (wf.triggers || []) as Array<{ type: string; isEnabled?: boolean; config?: Record<string, unknown> }>;
        const cfgs = triggers.map(t => `${t.type}:${t.isEnabled}:${JSON.stringify(t.config)}`);
        console.log(`  - ${wf.id} "${wf.name}": ${cfgs.join(', ')}`);
      }

      return matched.map((wf) => ({
        id: wf.id,
        name: wf.name,
        steps: (wf.steps || []) as WorkflowStepDef[],
      }));
    });

    if (!matchResult.length) {
      return { action: 'no_workflows' };
    }

    // ------------------------------------------------------------------
    // Step 2: Set hasActiveWorkflow = true
    // ------------------------------------------------------------------
    await step.do('set-active', async () => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
      await db.update(schema.helpdeskConversations)
        .set({ hasActiveWorkflow: true, updatedAt: new Date() })
        .where(eq(schema.helpdeskConversations.id, params.conversationId));
    });

    // ------------------------------------------------------------------
    // Step 3: Execute each matched workflow sequentially
    // ------------------------------------------------------------------
    const stepResults: Record<string, unknown> = {};

    for (const workflow of matchResult) {
      const mainSteps = workflow.steps
        .filter((s) => !s.parentBranchId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      // Create execution record
      const executionId = await step.do(`exec-create-${workflow.id}`, async () => {
        const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
        const execId = generateId('wex');
        const now = new Date();

        await db.insert(schema.helpdeskWorkflowExecutions).values({
          id: execId,
          helpdeskWorkflowId: workflow.id,
          workflowVersion: 1,
          workflowName: workflow.name,
          status: 'running',
          triggeredBy: 'system',
          triggerType: 'entity_event',
          triggerData: params.triggerData,
          startedAt: now,
          totalSteps: mainSteps.length,
          currentStepIndex: 0,
          conversationId: params.conversationId,
          channel: params.channel || 'web',
          executionContext: { cfInstanceId: event.instanceId },
          createdAt: now,
          updatedAt: now,
        });

        return execId;
      });

      // Variables (simplified — use trigger data and step results instead)
      const variables: Record<string, unknown> = {};

      // Execute steps
      for (let i = 0; i < mainSteps.length; i++) {
        const wfStep = mainSteps[i]!;

        const stepOutcome = await step.do(`step-${workflow.id}-${i}-${wfStep.id}`, async () => {
          const db = await getTenantDbForWorkspace(this.env, params.workspaceId);

          const execOpts: StepExecutionOptions = {
            db,
            env: this.env,
            conversationId: params.conversationId,
            workspaceId: params.workspaceId,
            executionId,
            triggerData: params.triggerData,
            stepResults,
            variables,
          };

          return executeStepHandler(wfStep, execOpts);
        });

        // Store result
        stepResults[wfStep.id] = stepOutcome.result;

        // Publish refetch hint so widget picks up any new messages from DB
        if (rt && stepOutcome.hasNewMessage) {
          try {
            await rt.conversationPublish(params.conversationId, {
              type: 'refetch',
              ts: Date.now(),
            });
          } catch {}
        }

        // Dispatch step output to external channel (Slack Block Kit, Discord embeds)
        if (stepOutcome.hasNewMessage && params.channel !== 'chat' && params.channel !== 'web') {
          try {
            const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
            await dispatchStepToChannel({
              db,
              env: this.env,
              conversationId: params.conversationId,
              workspaceId: params.workspaceId,
              channel: params.channel,
              stepType: wfStep.type,
              stepResult: (stepOutcome.result || {}) as Record<string, unknown>,
            });
          } catch (dispatchErr) {
            console.error(`[Workflow] Channel dispatch failed for ${wfStep.type}:`, dispatchErr);
          }
        }

        // Handle outcomes
        if (stepOutcome.type === 'waiting_for_input') {
          // Update execution state
          await step.do(`pause-${workflow.id}-${i}`, async () => {
            const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
            await db.update(schema.helpdeskWorkflowExecutions).set({
              status: 'waiting_for_input',
              currentStepIndex: i + 1,
              currentStepId: wfStep.id,
              executionContext: { stepResults, variables, waitingStepId: wfStep.id },
              updatedAt: new Date(),
            }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
          });

          // Wait for customer response (up to 30 minutes)
          const resumeEvent = await step.waitForEvent(`wait-${workflow.id}-${i}`, {
            type: 'customer_response',
            timeout: '30 minutes',
          });

          // Process resume
          const resumePayload = resumeEvent.payload as Record<string, unknown>;
          stepResults[wfStep.id] = {
            ...(stepResults[wfStep.id] as Record<string, unknown> || {}),
            ...resumePayload,
            responded: true,
          };

          // Update execution back to running
          await step.do(`resume-${workflow.id}-${i}`, async () => {
            const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
            await db.update(schema.helpdeskWorkflowExecutions).set({
              status: 'running',
              executionContext: { stepResults, variables },
              updatedAt: new Date(),
            }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
          });

          // Execute branch children if send_choices
          if (wfStep.type === 'send_choices' && resumePayload.selectedValue) {
            const branchId = `${wfStep.id}_branch_${resumePayload.selectedValue}`;
            const branchChildren = workflow.steps
              .filter((s) => s.parentBranchId === branchId)
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

            for (let j = 0; j < branchChildren.length; j++) {
              const branchStep = branchChildren[j]!;
              const branchOutcome = await step.do(`branch-${workflow.id}-${i}-${j}-${branchStep.id}`, async () => {
                const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
                return executeStepHandler(branchStep, {
                  db, env: this.env, conversationId: params.conversationId,
                  workspaceId: params.workspaceId, executionId,
                  triggerData: params.triggerData, stepResults, variables,
                });
              });
              stepResults[branchStep.id] = branchOutcome.result;

              if (rt && branchOutcome.hasNewMessage) {
                try { await rt.conversationPublish(params.conversationId, { type: 'refetch', ts: Date.now() }); } catch {}
              }
            }
          }

          continue;
        }

        // AI active loop — when AI replies without escalating, wait for next
        // customer message and run the AI again. Loop until escalation or timeout.
        if (
          (wfStep.type === 'ai_auto_reply' || wfStep.type === 'ai_agent') &&
          stepOutcome.type === 'completed' &&
          !(stepOutcome.result as any)?.escalated
        ) {
          // Mark execution as ai_active
          await step.do(`ai-active-${workflow.id}-${i}`, async () => {
            const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
            await db.update(schema.helpdeskWorkflowExecutions).set({
              status: 'ai_active',
              currentStepId: wfStep.id,
              executionContext: { cfInstanceId: event.instanceId, stepResults, variables, aiStepId: wfStep.id },
              updatedAt: new Date(),
            }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
          });

          let aiRound = 0;
          let escalated = false;

          while (!escalated) {
            // Wait for next customer message (up to 60 minutes)
            const msgEvent = await step.waitForEvent(`ai-msg-${workflow.id}-${i}-${aiRound}`, {
              type: 'customer_message',
              timeout: '60 minutes',
            });

            // Run AI handler again with the new message
            const aiOutcome = await step.do(`ai-respond-${workflow.id}-${i}-${aiRound}`, async () => {
              const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
              const msgPayload = msgEvent.payload as Record<string, unknown>;

              // Inject message content into trigger data for the handler
              const aiTriggerData = {
                ...params.triggerData,
                content: msgPayload.content || msgPayload.messageContent,
                customerName: msgPayload.customerName,
              };

              return executeStepHandler(wfStep, {
                db, env: this.env,
                conversationId: params.conversationId,
                workspaceId: params.workspaceId,
                executionId,
                triggerData: aiTriggerData,
                stepResults,
                variables,
              });
            });

            stepResults[`${wfStep.id}_round_${aiRound}`] = aiOutcome.result;

            // Publish refetch hint
            if (rt && aiOutcome.hasNewMessage) {
              try { await rt.conversationPublish(params.conversationId, { type: 'refetch', ts: Date.now() }); } catch {}
            }

            escalated = !!(aiOutcome.result as any)?.escalated;
            aiRound++;
          }

          // AI escalated — update execution back to running and continue with remaining steps
          await step.do(`ai-escalated-${workflow.id}-${i}`, async () => {
            const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
            await db.update(schema.helpdeskWorkflowExecutions).set({
              status: 'running',
              executionContext: { stepResults, variables },
              updatedAt: new Date(),
            }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
          });

          continue; // Continue to next step in the workflow
        }

        if (stepOutcome.type === 'delay') {
          await step.sleep(`delay-${workflow.id}-${i}`, stepOutcome.delayMs || 1000);
          continue;
        }

        if (stepOutcome.type === 'failed' && !wfStep.continueOnError) {
          // Mark execution failed
          await step.do(`fail-${workflow.id}`, async () => {
            const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
            await db.update(schema.helpdeskWorkflowExecutions).set({
              status: 'failed',
              error: { message: stepOutcome.error || 'Step failed' },
              completedAt: new Date(),
              updatedAt: new Date(),
            }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
          });
          break;
        }
      }

      // Complete execution (if not already failed)
      await step.do(`complete-${workflow.id}`, async () => {
        const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
        const [exec] = await db.select({ status: schema.helpdeskWorkflowExecutions.status })
          .from(schema.helpdeskWorkflowExecutions)
          .where(eq(schema.helpdeskWorkflowExecutions.id, executionId))
          .limit(1);

        if (exec?.status === 'running') {
          await db.update(schema.helpdeskWorkflowExecutions).set({
            status: 'completed',
            completedAt: new Date(),
            output: stepResults,
            updatedAt: new Date(),
          }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
        }
      });
    }

    // ------------------------------------------------------------------
    // Step 4: Finalize — clear hasActiveWorkflow, notify agents
    // ------------------------------------------------------------------
    await step.do('finalize', async () => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
      await db.update(schema.helpdeskConversations)
        .set({ hasActiveWorkflow: false, updatedAt: new Date() })
        .where(eq(schema.helpdeskConversations.id, params.conversationId));
    });

    // Publish final refetch hint
    if (rt) {
      try {
        await rt.conversationPublish(params.conversationId, { type: 'refetch', ts: Date.now() });
        await rt.helpdeskEvent(params.workspaceId, 'conversation_new', {
          conversationId: params.conversationId,
        });
      } catch {}
    }

    return { success: true, action: 'completed', workflowCount: matchResult.length };
  }
}
