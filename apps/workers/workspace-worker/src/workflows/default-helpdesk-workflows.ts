/**
 * Default Helpdesk Workflow Definitions
 *
 * Shared module defining the default workflows that are seeded into new workspaces
 * and can be backfilled into existing ones. Uses stable templateId constants for
 * idempotent inserts.
 *
 * IMPORTANT: Step types must match the handlers registered in:
 *   - helpdesk-widget-api/services/workflow-executor.ts (customer-facing SSE steps)
 *   - helpdesk-workflow-worker/services/action-handlers.ts (backend CF Workflow steps)
 *
 * Customer-facing: send_message, delay, send_choices, collect_input, collect_customer_info,
 *                  suggest_articles, ai_auto_reply, ai_agent
 * Backend-only:    assign_conversation, tag_conversation, change_conversation_status,
 *                  change_priority, add_internal_note, send_notification, apply_sla,
 *                  create_ticket_from_conversation, trigger_csat, send_reply, log,
 *                  set_variable, condition, delay
 *
 * Audience exclusivity: workflow-stream.ts runs only ONE workflow per audience group.
 * Workflows sharing the same audience (default: 'all') compete by sortOrder — first wins.
 * To run multiple workflows on the same trigger, assign different audience values.
 */

import type { HelpdeskTriggerConfig as TriggerConfig, HelpdeskWorkflowStep as WorkflowStep, HelpdeskWorkflowSettings as WorkflowSettings } from '@weldsuite/db/schema/helpdesk-workflow-types';
import type { NewHelpdeskWorkflow } from '@weldsuite/db/schema/helpdesk-workflows';

// ============================================================================
// Stable Template IDs (used for idempotent upserts)
// ============================================================================

export const DEFAULT_WORKFLOW_TEMPLATE_IDS = [
  'hwf_tpl_collect_info',
  'hwf_tpl_welcome',
  'hwf_tpl_auto_assign',
  'hwf_tpl_csat_resolved',
] as const;

export type DefaultWorkflowTemplateId = (typeof DEFAULT_WORKFLOW_TEMPLATE_IDS)[number];

// ============================================================================
// Workflow Definitions
// ============================================================================

/**
 * Returns an array of default helpdesk workflow definitions ready for insertion.
 * @param generateIdFn - Function to generate unique IDs (e.g. `generateId('hwf')`)
 */
export function getDefaultHelpdeskWorkflows(
  generateIdFn: (prefix: string) => string,
): NewHelpdeskWorkflow[] {
  const now = new Date();

  return [
    // ── 1. Collect Customer Info ──────────────────────────────────────────
    {
      id: generateIdFn('hwf'),
      name: 'Collect Customer Info',
      description: 'Asks unidentified visitors for their name and email before routing the conversation.',
      status: 'active',
      version: 1,
      sortOrder: 5,
      templateId: 'hwf_tpl_collect_info',
      createdBy: 'system',
      tags: ['system-default'],
      triggers: [
        {
          id: 'trg_collect_info',
          type: 'entity_event',
          name: 'New conversation from visitor',
          isEnabled: true,
          config: {
            type: 'entity_event',
            entityType: 'helpdesk_conversation',
            eventType: 'created',
            channels: ['chat'],
          } satisfies TriggerConfig['config'],
        },
      ] satisfies TriggerConfig[],
      steps: [
        {
          id: 'step_collect',
          type: 'collect_customer_info',
          name: 'Collect customer data',
          order: 1,
          config: {},
          inputs: {
            message: "Hi there! Before we connect you with our team, could you share your details so we can assist you better?",
            fields: [
              { id: 'name', label: 'Name', type: 'text', required: false, placeholder: 'Your name' },
              { id: 'email', label: 'Email', type: 'email', required: true, placeholder: 'your@email.com' },
            ],
          },
        },
        {
          id: 'step_confirm',
          type: 'send_message',
          name: 'Confirmation',
          order: 2,
          config: {},
          inputs: {
            message: "Thanks! Let me connect you with our team now.",
          },
        },
      ] satisfies WorkflowStep[],
      settings: {
        logLevel: 'info',
      } satisfies WorkflowSettings,
      createdAt: now,
      updatedAt: now,
    },

    // ── 2. Welcome Message ───────────────────────────────────────────────
    {
      id: generateIdFn('hwf'),
      name: 'Welcome Message',
      description: 'Sends a friendly greeting when a new conversation starts, with business hours information. Enable this instead of "Collect Customer Info" if you don\'t need to collect visitor emails.',
      status: 'draft',
      version: 1,
      sortOrder: 10,
      templateId: 'hwf_tpl_welcome',
      createdBy: 'system',
      tags: ['system-default'],
      triggers: [
        {
          id: 'trg_welcome',
          type: 'entity_event',
          name: 'New conversation created',
          isEnabled: true,
          config: {
            type: 'entity_event',
            entityType: 'helpdesk_conversation',
            eventType: 'created',
            channels: ['chat'],
          } satisfies TriggerConfig['config'],
        },
      ] satisfies TriggerConfig[],
      steps: [
        {
          id: 'step_greet',
          type: 'send_message',
          name: 'Send welcome message',
          order: 1,
          config: {},
          inputs: {
            message: "Welcome! We typically respond within a few minutes during business hours (Mon-Fri, 9AM-5PM). How can we help you today?",
          },
        },
      ] satisfies WorkflowStep[],
      settings: {
        logLevel: 'info',
      } satisfies WorkflowSettings,
      createdAt: now,
      updatedAt: now,
    },

    // ── 3. Auto-Assign Round Robin (draft) ───────────────────────────────
    {
      id: generateIdFn('hwf'),
      name: 'Auto-Assign Round Robin',
      description: 'Automatically assigns new conversations to available agents in round-robin order.',
      status: 'draft',
      version: 1,
      sortOrder: 20,
      templateId: 'hwf_tpl_auto_assign',
      createdBy: 'system',
      tags: ['system-default'],
      triggers: [
        {
          id: 'trg_auto_assign',
          type: 'entity_event',
          name: 'New conversation created',
          isEnabled: true,
          config: {
            type: 'entity_event',
            entityType: 'helpdesk_conversation',
            eventType: 'created',
          } satisfies TriggerConfig['config'],
        },
      ] satisfies TriggerConfig[],
      steps: [
        {
          id: 'step_assign',
          type: 'assign_conversation',
          name: 'Round-robin assignment',
          order: 1,
          config: {},
          inputs: {
            strategy: 'round_robin',
          },
        },
        {
          id: 'step_notify',
          type: 'send_notification',
          name: 'Notify assigned agent',
          order: 2,
          config: {},
          inputs: {
            title: 'New conversation assigned',
            body: 'A new conversation has been assigned to you.',
          },
        },
      ] satisfies WorkflowStep[],
      settings: {
        logLevel: 'info',
      } satisfies WorkflowSettings,
      createdAt: now,
      updatedAt: now,
    },

    // ── 4. CSAT After Resolution (draft) ─────────────────────────────────
    {
      id: generateIdFn('hwf'),
      name: 'CSAT After Resolution',
      description: 'Sends a customer satisfaction survey after a conversation is resolved.',
      status: 'draft',
      version: 1,
      sortOrder: 30,
      templateId: 'hwf_tpl_csat_resolved',
      createdBy: 'system',
      tags: ['system-default'],
      triggers: [
        {
          id: 'trg_csat_resolved',
          type: 'entity_event',
          name: 'Conversation resolved',
          isEnabled: true,
          config: {
            type: 'entity_event',
            entityType: 'helpdesk_conversation',
            eventType: 'status_changed',
            filters: [
              { field: 'status', operator: 'equals', value: 'resolved' },
            ],
          } satisfies TriggerConfig['config'],
        },
      ] satisfies TriggerConfig[],
      steps: [
        {
          id: 'step_delay',
          type: 'delay',
          name: 'Wait before sending survey',
          order: 1,
          config: {},
          inputs: {
            minutes: 60,
          },
        },
        {
          id: 'step_send_csat',
          type: 'trigger_csat',
          name: 'Send CSAT survey',
          order: 2,
          config: {},
          inputs: {
            delayMinutes: 0,
          },
        },
      ] satisfies WorkflowStep[],
      settings: {
        logLevel: 'info',
      } satisfies WorkflowSettings,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
