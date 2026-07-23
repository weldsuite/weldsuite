import { z } from 'zod';

// ============================================================================
// Available actions / triggers the AI knows about
// ============================================================================

export const BUILDER_TRIGGER_TYPES = [
  'manual',
  'schedule',
  'entity_event',
  'webhook',
  'workflow_complete',
] as const;
export type BuilderTriggerType = (typeof BUILDER_TRIGGER_TYPES)[number];

export const BUILDER_ACTION_TYPES = [
  'send_email',
  'send_message',
  'send_notification',
  'send_choices',
  'create_ticket',
  'assign_conversation',
  'change_status',
  'change_priority',
  'ai_classify',
  'ai_summarize',
  'ai_translate',
  'ai_auto_reply',
  'ai_sentiment',
  'delay',
  'manual_step',
  'collect_input',
  'goto_step',
] as const;
export type BuilderActionType = (typeof BUILDER_ACTION_TYPES)[number];

export interface BuilderActionDescriptor {
  id: BuilderActionType;
  label: string;
  description: string;
}

export const BUILDER_ACTION_LIBRARY: BuilderActionDescriptor[] = [
  { id: 'send_email', label: 'Send email', description: 'Send an email to one or more recipients.' },
  { id: 'send_message', label: 'Send message', description: 'Send a message into a conversation.' },
  { id: 'send_notification', label: 'Send in-app notification', description: 'Notify a user inside WeldSuite.' },
  { id: 'send_choices', label: 'Ask user to pick an option', description: 'Render quick-reply choices in a chat.' },
  { id: 'create_ticket', label: 'Create helpdesk ticket', description: 'Open a new ticket in WeldDesk.' },
  { id: 'assign_conversation', label: 'Assign conversation', description: 'Route a conversation to an agent or team.' },
  { id: 'change_status', label: 'Change status', description: 'Update the status of an entity (ticket, task, etc.).' },
  { id: 'change_priority', label: 'Change priority', description: 'Update the priority of an entity.' },
  { id: 'ai_classify', label: 'AI: classify', description: 'Use AI to classify text into one of N categories.' },
  { id: 'ai_summarize', label: 'AI: summarize', description: 'Use AI to summarize a body of text.' },
  { id: 'ai_translate', label: 'AI: translate', description: 'Use AI to translate text into another language.' },
  { id: 'ai_auto_reply', label: 'AI: auto-reply', description: 'Use AI to draft a reply to an inbound message.' },
  { id: 'ai_sentiment', label: 'AI: sentiment', description: 'Use AI to detect sentiment in a message.' },
  { id: 'delay', label: 'Wait', description: 'Pause the workflow for a fixed duration.' },
  { id: 'manual_step', label: 'Wait for human approval', description: 'Pause until a human approves or rejects.' },
  { id: 'collect_input', label: 'Collect input from user', description: 'Ask the user to fill in a small form.' },
  { id: 'goto_step', label: 'Jump to another step', description: 'Branch flow to a labelled step.' },
];

// ============================================================================
// Tool input schemas (what the AI emits)
// ============================================================================

export const proposeChoicesInput = z.object({
  question: z.string().min(1).max(500),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(80),
        description: z.string().max(200).optional(),
      }),
    )
    .min(2)
    .max(6),
  allowFreeText: z.boolean().optional().default(true),
});
export type ProposeChoicesInput = z.infer<typeof proposeChoicesInput>;

export const proposeTriggerInput = z.object({
  type: z.enum(BUILDER_TRIGGER_TYPES),
  label: z.string().min(1).max(120),
  config: z.record(z.unknown()).default({}),
});
export type ProposeTriggerInput = z.infer<typeof proposeTriggerInput>;

export const proposeActionInput = z.object({
  type: z.enum(BUILDER_ACTION_TYPES),
  label: z.string().min(1).max(120),
  description: z.string().max(280).optional(),
  config: z.record(z.unknown()).default({}),
  afterStepId: z.string().nullish(),
});
export type ProposeActionInput = z.infer<typeof proposeActionInput>;

export const proposeConditionInput = z.object({
  label: z.string().min(1).max(120),
  expression: z.string().min(1).max(500),
  branches: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        description: z.string().max(200).optional(),
      }),
    )
    .min(2)
    .max(4),
  afterStepId: z.string().nullish(),
});
export type ProposeConditionInput = z.infer<typeof proposeConditionInput>;

export const removeStepInput = z.object({
  stepId: z.string().min(1),
});
export type RemoveStepInput = z.infer<typeof removeStepInput>;

export const finalizeWorkflowInput = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
});
export type FinalizeWorkflowInput = z.infer<typeof finalizeWorkflowInput>;

// ============================================================================
// Builder message events (delivered to client via SSE tool-output frames)
// ============================================================================

export interface BuilderTriggerNode {
  id: string;
  kind: 'trigger';
  triggerType: BuilderTriggerType;
  label: string;
  config: Record<string, unknown>;
}

export interface BuilderActionNode {
  id: string;
  kind: 'action';
  actionType: BuilderActionType;
  label: string;
  description?: string;
  config: Record<string, unknown>;
}

export interface BuilderConditionNode {
  id: string;
  kind: 'condition';
  label: string;
  expression: string;
  branches: Array<{ label: string; description?: string }>;
}

export type BuilderNode = BuilderTriggerNode | BuilderActionNode | BuilderConditionNode;

export interface WorkflowDraft {
  id: string;
  name: string;
  description: string | null;
  status: string;
  trigger: BuilderTriggerNode | null;
  steps: Array<BuilderActionNode | BuilderConditionNode>;
  finalized: boolean;
}

// ============================================================================
// HTTP request / response schemas
// ============================================================================

export const createBuilderDraftInput = z.object({
  initialMessage: z.string().max(2000).optional(),
});
export type CreateBuilderDraftInput = z.infer<typeof createBuilderDraftInput>;

export const builderChatInput = z.object({
  draftId: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
    }),
  ),
});
export type BuilderChatInput = z.infer<typeof builderChatInput>;

export const finalizeBuilderDraftInput = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(500).optional(),
});
export type FinalizeBuilderDraftInput = z.infer<typeof finalizeBuilderDraftInput>;
