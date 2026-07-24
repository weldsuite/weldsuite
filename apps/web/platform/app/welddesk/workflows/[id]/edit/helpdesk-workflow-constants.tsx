import React from 'react';
import {
  GitBranch,
  Clock,
  UserPlus,
  UserMinus,
  User,
  Tag,
  CircleDot,
  ArrowUpCircle,
  StickyNote,
  Star,
  Bot,
  MessageSquare,
  MessageSquareText,
  ListChecks,
  ClipboardList,
  BookOpen,
  CheckCircle,
} from 'lucide-react';
import type { VariableGroup } from '@weldsuite/ui/components/workflow-canvas/parts/variable-picker';
import type { WorkflowStep, WorkflowTrigger } from './types';

// ============================================================================
// Triggers — 4 essential conversation events
// ============================================================================

export interface HelpdeskTriggerDef {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  entityType: string;
  eventType: string;
  category?: string;
}

export const TRIGGER_CATEGORIES = [
  { id: 'conversation' as const, label: 'Conversation events' },
];

export const HELPDESK_ROUTING_TRIGGERS: HelpdeskTriggerDef[] = [
  { id: 'conv_created', label: 'When a customer starts a new conversation', description: 'Fires when a new conversation is created', icon: MessageSquare, entityType: 'helpdesk_conversation', eventType: 'created', category: 'conversation' },
  { id: 'msg_created', label: 'When a customer sends a message', description: 'Fires every time a customer sends a message', icon: MessageSquareText, entityType: 'helpdesk_conversation_message', eventType: 'created', category: 'conversation' },
  { id: 'conv_assigned', label: 'When a conversation is assigned', description: 'Fires when a conversation is assigned to a teammate or team', icon: UserPlus, entityType: 'helpdesk_conversation', eventType: 'assigned', category: 'conversation' },
  { id: 'conv_closed', label: 'When a conversation is closed', description: 'Fires when a conversation is closed or resolved', icon: CheckCircle, entityType: 'helpdesk_conversation', eventType: 'closed', category: 'conversation' },
];

// ============================================================================
// Actions — 15 core actions
// ============================================================================

export type ActionCategory = 'communicate' | 'ai' | 'route' | 'act' | 'control';

export interface SidebarActionType {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  category: ActionCategory;
}

export const HELPDESK_ACTION_TYPES: SidebarActionType[] = [
  // ── Communicate ──
  { id: 'send_message', name: 'Send message', description: 'Send a bot message to the customer', icon: MessageSquareText, category: 'communicate' },
  { id: 'send_choices', name: 'Reply buttons', description: 'Present reply buttons the customer can tap', icon: ListChecks, category: 'communicate' },
  { id: 'collect_input', name: 'Ask a question', description: 'Ask the customer for free-text information', icon: ClipboardList, category: 'communicate' },
  { id: 'suggest_articles', name: 'Share articles', description: 'Search and suggest help center articles', icon: BookOpen, category: 'communicate' },
  { id: 'add_internal_note', name: 'Add note', description: 'Add an internal-only note to the conversation', icon: StickyNote, category: 'communicate' },

  // ── AI ── AI has been removed platform-wide — 'ai_auto_reply' is no longer
  // offered in the action picker. Existing workflow steps of this type still
  // render (ACTION_META below keeps its icon/color), they just can't be
  // added fresh or (per NO_CONFIG_STEPS) configured.

  // ── Route ──
  { id: 'assign_conversation', name: 'Assign to team or teammate', description: 'Route the conversation to a specific person or team', icon: UserPlus, category: 'route' },
  { id: 'unassign_conversation', name: 'Unassign conversation', description: 'Remove the current assignment', icon: UserMinus, category: 'route' },

  // ── Act ──
  { id: 'tag_conversation', name: 'Add tag', description: 'Add tags to the conversation', icon: Tag, category: 'act' },
  { id: 'change_status', name: 'Change status', description: 'Update status (active, pending, resolved)', icon: CircleDot, category: 'act' },
  { id: 'close_conversation', name: 'Close conversation', description: 'Mark the conversation as closed', icon: CheckCircle, category: 'act' },
  { id: 'change_priority', name: 'Set priority', description: 'Change the priority level', icon: ArrowUpCircle, category: 'act' },
  { id: 'trigger_csat', name: 'Send CSAT survey', description: 'Send a customer satisfaction survey', icon: Star, category: 'act' },
  { id: 'set_contact_attribute', name: 'Set contact attribute', description: 'Set a field on the contact (built-in or custom)', icon: User, category: 'act' },
  { id: 'set_conversation_attribute', name: 'Set conversation attribute', description: 'Set a custom field on the conversation', icon: MessageSquare, category: 'act' },

  // ── Control ──
  { id: 'condition', name: 'Condition', description: 'Branch the flow based on a condition', icon: GitBranch, category: 'control' },
  { id: 'delay', name: 'Wait', description: 'Wait for a specified amount of time', icon: Clock, category: 'control' },
];

// ============================================================================
// Terminal Actions
// ============================================================================

export const TERMINAL_ACTION_TYPES = new Set(['send_choices', 'ai_auto_reply']);

export function isTerminalAction(type: string): boolean {
  return TERMINAL_ACTION_TYPES.has(type);
}

// ============================================================================
// Action Categories
// ============================================================================

export const ACTION_CATEGORIES: Array<{ id: ActionCategory; label: string }> = [
  { id: 'communicate', label: 'Communicate' },
  { id: 'ai', label: 'AI' },
  { id: 'route', label: 'Route' },
  { id: 'act', label: 'Act' },
  { id: 'control', label: 'Control' },
];

export const CATEGORY_LABELS: Record<string, string> = {
  communicate: 'Communicate',
  ai: 'AI',
  route: 'Route',
  act: 'Act',
  control: 'Control',
};

// ============================================================================
// Action Meta (icons and colors)
// ============================================================================

const ACTION_META: Record<string, { icon: React.ElementType; color: string; bgColor: string; borderColor: string }> = {
  send_message: { icon: MessageSquareText, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30', borderColor: 'border-cyan-200 dark:border-cyan-800/40' },
  send_choices: { icon: ListChecks, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30', borderColor: 'border-cyan-200 dark:border-cyan-800/40' },
  collect_input: { icon: ClipboardList, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30', borderColor: 'border-cyan-200 dark:border-cyan-800/40' },
  suggest_articles: { icon: BookOpen, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30', borderColor: 'border-cyan-200 dark:border-cyan-800/40' },
  add_internal_note: { icon: StickyNote, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30', borderColor: 'border-cyan-200 dark:border-cyan-800/40' },
  ai_auto_reply: { icon: Bot, color: 'text-violet-600', bgColor: 'bg-violet-100 dark:bg-violet-900/30', borderColor: 'border-violet-200 dark:border-violet-800/40' },
  assign_conversation: { icon: UserPlus, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  unassign_conversation: { icon: UserMinus, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  tag_conversation: { icon: Tag, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  change_status: { icon: CircleDot, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  change_conversation_status: { icon: CircleDot, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  close_conversation: { icon: CheckCircle, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  change_priority: { icon: ArrowUpCircle, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  trigger_csat: { icon: Star, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  set_contact_attribute: { icon: User, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  set_conversation_attribute: { icon: MessageSquare, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30', borderColor: 'border-teal-200 dark:border-teal-800/40' },
  condition: { icon: GitBranch, color: 'text-orange-600', bgColor: 'bg-orange-100 dark:bg-orange-900/30', borderColor: 'border-orange-200 dark:border-orange-800/40' },
  delay: { icon: Clock, color: 'text-gray-600 dark:text-gray-400', bgColor: 'bg-gray-100 dark:bg-secondary', borderColor: 'border-gray-200 dark:border-gray-700/40' },
};

export function getActionMeta(type: string) {
  return ACTION_META[type] || { icon: MessageSquareText, color: 'text-primary', bgColor: 'bg-primary/10', borderColor: 'border-primary/20' };
}

// ============================================================================
// Variable Groups
// ============================================================================

export const HELPDESK_VARIABLE_GROUPS: VariableGroup[] = [
  {
    id: 'helpdesk_conversation',
    label: 'Conversation',
    icon: <MessageSquare className="h-4 w-4 text-teal-500" />,
    variables: [
      { path: 'trigger.data.id', label: 'Conversation ID', type: 'string' },
      { path: 'trigger.data.subject', label: 'Subject', type: 'string' },
      { path: 'trigger.data.status', label: 'Status', type: 'string' },
      { path: 'trigger.data.priority', label: 'Priority', type: 'string' },
      { path: 'trigger.data.channel', label: 'Channel', type: 'string' },
      { path: 'trigger.data.assigneeId', label: 'Assignee ID', type: 'string' },
      { path: 'trigger.data.assigneeName', label: 'Assignee Name', type: 'string' },
      { path: 'trigger.data.tags', label: 'Tags', type: 'array' },
      { path: 'trigger.data.preview', label: 'Last Message Preview', type: 'string' },
    ],
  },
  {
    id: 'helpdesk_customer',
    label: 'Customer',
    icon: <MessageSquare className="h-4 w-4 text-teal-500" />,
    variables: [
      { path: 'trigger.data.customerName', label: 'Customer Name', type: 'string' },
      { path: 'trigger.data.customerEmail', label: 'Customer Email', type: 'string' },
      { path: 'trigger.data.contactId', label: 'Contact ID', type: 'string' },
    ],
  },
  {
    id: 'helpdesk_message',
    label: 'Message',
    icon: <MessageSquare className="h-4 w-4 text-teal-500" />,
    variables: [
      { path: 'trigger.data.content', label: 'Content', type: 'string' },
      { path: 'trigger.data.authorType', label: 'Author Type', type: 'string' },
      { path: 'trigger.data.authorName', label: 'Author Name', type: 'string' },
    ],
  },
];

/**
 * Generate dynamic variable groups from preceding steps.
 */
export function getDynamicVariableGroups(
  steps: Array<{ id: string; type: string; name: string; config?: Record<string, unknown> }>,
  currentStepIndex: number,
): VariableGroup[] {
  const groups: VariableGroup[] = [];

  for (let i = 0; i < currentStepIndex; i++) {
    const step = steps[i];
    if (!step) continue;

    if (step.type === 'send_choices') {
      groups.push({
        id: `step_${step.id}`,
        label: step.name || 'Send Choices',
        icon: <ListChecks className="h-4 w-4 text-cyan-500" />,
        variables: [
          { path: `steps.${step.id}.selectedValue`, label: 'Selected Value', type: 'string' },
          { path: `steps.${step.id}.selectedLabel`, label: 'Selected Label', type: 'string' },
        ],
      });
    }

    if (step.type === 'collect_input') {
      const rawFields = (step.config?.fields) as Array<{ id: string; label: string }> | undefined;
      const fields = rawFields || [];
      groups.push({
        id: `step_${step.id}`,
        label: step.name || 'Collect Input',
        icon: <ClipboardList className="h-4 w-4 text-cyan-500" />,
        variables: fields.map(f => ({
          path: `steps.${step.id}.${f.id}`,
          label: f.label || f.id,
          type: 'string' as const,
        })),
      });
    }
  }

  return groups;
}

// ============================================================================
// AI Models
// ============================================================================

export const AVAILABLE_MODELS = [
  { value: 'openai/gpt-4o', label: 'GPT-4o' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'anthropic/claude-3-5-haiku-latest', label: 'Claude Haiku' },
  { value: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
];

export const AGENT_TOOLS = [
  { name: 'search_knowledge_base', label: 'Search Knowledge Base', description: 'Search published help articles' },
  { name: 'escalate_to_human', label: 'Escalate to Human', description: 'Hand off to a human agent' },
  { name: 'get_conversation_history', label: 'Get Conversation History', description: 'Read recent messages' },
  { name: 'get_customer_info', label: 'Get Customer Info', description: 'Look up customer data' },
];

// ============================================================================
// Channels
// ============================================================================

export const WORKFLOW_CHANNELS = [
  { value: 'web', label: 'Web', icon: 'Globe' },
  { value: 'email', label: 'Email', icon: 'Mail' },
  { value: 'chat', label: 'Live chat', icon: 'MessageCircle' },
  { value: 'discord', label: 'Discord', icon: 'MessageSquare' },
  { value: 'slack', label: 'Slack', icon: 'MessageSquare' },
] as const;

export const WORKFLOW_AUDIENCES = [
  { value: 'leads', label: 'Leads', icon: 'UserPlus' },
  { value: 'users', label: 'Users', icon: 'Users' },
  { value: 'visitors', label: 'Visitors', icon: 'Eye' },
] as const;

// ============================================================================
// Available Actions by Trigger
// ============================================================================

/**
 * Return the list of action types available for the given trigger.
 */
export function getAvailableActions(
  _trigger: { entityType?: string; eventType?: string } | null | undefined,
  actionTypes?: SidebarActionType[],
): SidebarActionType[] {
  return actionTypes ?? HELPDESK_ACTION_TYPES;
}

// ============================================================================
// Warning Helpers
// ============================================================================

export function getTriggerWarningMessage(trigger: WorkflowTrigger | null | undefined): string | null {
  if (!trigger || !trigger.type) return 'No trigger configured';
  if (trigger.type === 'entity_event') {
    const missing = [];
    if (!trigger.entityType) missing.push('entity type');
    if (!trigger.eventType) missing.push('event type');
    return missing.length > 0 ? `Missing ${missing.join(' and ')}` : null;
  }
  return null;
}

const NO_CONFIG_STEPS = new Set(['ai_auto_reply', 'close_conversation', 'unassign_conversation']);

export function getStepWarningMessage(step: WorkflowStep): string | null {
  if (NO_CONFIG_STEPS.has(step.type)) return null;
  const config = step.config || {};
  if (Object.keys(config).length === 0) return 'This step is not configured yet';
  if (step.type === 'condition' && !config.expression) return 'Missing condition expression';
  if (step.type === 'delay' && (!config.duration || (config.duration as number) <= 0)) return 'Missing duration';
  return null;
}

// ============================================================================
// Translated factory functions
// ============================================================================

export interface WorkflowConstantsTranslations {
  triggerCategoryConversation: string;
  actionSendMessage: string;
  actionReplyButtons: string;
  actionAskQuestion: string;
  actionShareArticles: string;
  actionAddNote: string;
  actionReplyWithAgent: string;
  actionAssignToTeam: string;
  actionUnassign: string;
  actionAddTag: string;
  actionChangeStatus: string;
  actionCloseConversation: string;
  actionSetPriority: string;
  actionSendCsat: string;
  actionCondition: string;
  actionWait: string;
  descSendMessage: string;
  descReplyButtons: string;
  descAskQuestion: string;
  descShareArticles: string;
  descAddNote: string;
  descReplyWithAgent: string;
  descAssignToTeam: string;
  descUnassign: string;
  descAddTag: string;
  descChangeStatus: string;
  descCloseConversation: string;
  descSetPriority: string;
  descSendCsat: string;
  descCondition: string;
  descWait: string;
  categoryCommunicate: string;
  categoryAi: string;
  categoryRoute: string;
  categoryAct: string;
  categoryControl: string;
  triggerConvCreated: string;
  triggerConvCreatedDesc: string;
  triggerMsgCreated: string;
  triggerMsgCreatedDesc: string;
  triggerConvAssigned: string;
  triggerConvAssignedDesc: string;
  triggerConvClosed: string;
  triggerConvClosedDesc: string;
  varGroupConversation: string;
  varGroupCustomer: string;
  varGroupMessage: string;
  varConversationId: string;
  varSubject: string;
  varStatus: string;
  varPriority: string;
  varChannel: string;
  varAssigneeId: string;
  varAssigneeName: string;
  varTags: string;
  varLastMessagePreview: string;
  varCustomerName: string;
  varCustomerEmail: string;
  varContactId: string;
  varContent: string;
  varAuthorType: string;
  varAuthorName: string;
  varSelectedValue: string;
  varSelectedLabel: string;
  stepSendChoices: string;
  stepCollectInput: string;
  toolSearchKb: string;
  toolSearchKbDesc: string;
  toolEscalate: string;
  toolEscalateDesc: string;
  toolGetHistory: string;
  toolGetHistoryDesc: string;
  toolGetCustomer: string;
  toolGetCustomerDesc: string;
  channelWeb: string;
  channelEmail: string;
  channelLiveChat: string;
  channelDiscord: string;
  channelSlack: string;
  audienceLeads: string;
  audienceUsers: string;
  audienceVisitors: string;
}

export function getHelpdeskActionTypes(tc: WorkflowConstantsTranslations): SidebarActionType[] {
  return [
    { id: 'send_message', name: tc.actionSendMessage, description: tc.descSendMessage, icon: MessageSquareText, category: 'communicate' },
    { id: 'send_choices', name: tc.actionReplyButtons, description: tc.descReplyButtons, icon: ListChecks, category: 'communicate' },
    { id: 'collect_input', name: tc.actionAskQuestion, description: tc.descAskQuestion, icon: ClipboardList, category: 'communicate' },
    { id: 'suggest_articles', name: tc.actionShareArticles, description: tc.descShareArticles, icon: BookOpen, category: 'communicate' },
    { id: 'add_internal_note', name: tc.actionAddNote, description: tc.descAddNote, icon: StickyNote, category: 'communicate' },
    // AI has been removed platform-wide — 'ai_auto_reply' ("Reply with
    // WeldAgent") is no longer offered here.
    { id: 'assign_conversation', name: tc.actionAssignToTeam, description: tc.descAssignToTeam, icon: UserPlus, category: 'route' },
    { id: 'unassign_conversation', name: tc.actionUnassign, description: tc.descUnassign, icon: UserMinus, category: 'route' },
    { id: 'tag_conversation', name: tc.actionAddTag, description: tc.descAddTag, icon: Tag, category: 'act' },
    { id: 'change_status', name: tc.actionChangeStatus, description: tc.descChangeStatus, icon: CircleDot, category: 'act' },
    { id: 'close_conversation', name: tc.actionCloseConversation, description: tc.descCloseConversation, icon: CheckCircle, category: 'act' },
    { id: 'change_priority', name: tc.actionSetPriority, description: tc.descSetPriority, icon: ArrowUpCircle, category: 'act' },
    { id: 'trigger_csat', name: tc.actionSendCsat, description: tc.descSendCsat, icon: Star, category: 'act' },
    { id: 'condition', name: tc.actionCondition, description: tc.descCondition, icon: GitBranch, category: 'control' },
    { id: 'delay', name: tc.actionWait, description: tc.descWait, icon: Clock, category: 'control' },
  ];
}

export function getHelpdeskActionCategories(tc: WorkflowConstantsTranslations): Array<{ id: ActionCategory; label: string }> {
  return [
    { id: 'communicate', label: tc.categoryCommunicate },
    { id: 'route', label: tc.categoryRoute },
    { id: 'act', label: tc.categoryAct },
    { id: 'control', label: tc.categoryControl },
  ];
}

export function getHelpdeskCategoryLabels(tc: WorkflowConstantsTranslations): Record<string, string> {
  return {
    communicate: tc.categoryCommunicate,
    ai: tc.categoryAi,
    route: tc.categoryRoute,
    act: tc.categoryAct,
    control: tc.categoryControl,
  };
}

export function getHelpdeskRoutingTriggers(tc: WorkflowConstantsTranslations): HelpdeskTriggerDef[] {
  return [
    { id: 'conv_created', label: tc.triggerConvCreated, description: tc.triggerConvCreatedDesc, icon: MessageSquare, entityType: 'helpdesk_conversation', eventType: 'created', category: 'conversation' },
    { id: 'msg_created', label: tc.triggerMsgCreated, description: tc.triggerMsgCreatedDesc, icon: MessageSquareText, entityType: 'helpdesk_conversation_message', eventType: 'created', category: 'conversation' },
    { id: 'conv_assigned', label: tc.triggerConvAssigned, description: tc.triggerConvAssignedDesc, icon: UserPlus, entityType: 'helpdesk_conversation', eventType: 'assigned', category: 'conversation' },
    { id: 'conv_closed', label: tc.triggerConvClosed, description: tc.triggerConvClosedDesc, icon: CheckCircle, entityType: 'helpdesk_conversation', eventType: 'closed', category: 'conversation' },
  ];
}

export function getHelpdeskVariableGroups(tc: WorkflowConstantsTranslations): VariableGroup[] {
  return [
    {
      id: 'helpdesk_conversation',
      label: tc.varGroupConversation,
      icon: <MessageSquare className="h-4 w-4 text-teal-500" />,
      variables: [
        { path: 'trigger.data.id', label: tc.varConversationId, type: 'string' },
        { path: 'trigger.data.subject', label: tc.varSubject, type: 'string' },
        { path: 'trigger.data.status', label: tc.varStatus, type: 'string' },
        { path: 'trigger.data.priority', label: tc.varPriority, type: 'string' },
        { path: 'trigger.data.channel', label: tc.varChannel, type: 'string' },
        { path: 'trigger.data.assigneeId', label: tc.varAssigneeId, type: 'string' },
        { path: 'trigger.data.assigneeName', label: tc.varAssigneeName, type: 'string' },
        { path: 'trigger.data.tags', label: tc.varTags, type: 'array' },
        { path: 'trigger.data.preview', label: tc.varLastMessagePreview, type: 'string' },
      ],
    },
    {
      id: 'helpdesk_customer',
      label: tc.varGroupCustomer,
      icon: <MessageSquare className="h-4 w-4 text-teal-500" />,
      variables: [
        { path: 'trigger.data.customerName', label: tc.varCustomerName, type: 'string' },
        { path: 'trigger.data.customerEmail', label: tc.varCustomerEmail, type: 'string' },
        { path: 'trigger.data.contactId', label: tc.varContactId, type: 'string' },
      ],
    },
    {
      id: 'helpdesk_message',
      label: tc.varGroupMessage,
      icon: <MessageSquare className="h-4 w-4 text-teal-500" />,
      variables: [
        { path: 'trigger.data.content', label: tc.varContent, type: 'string' },
        { path: 'trigger.data.authorType', label: tc.varAuthorType, type: 'string' },
        { path: 'trigger.data.authorName', label: tc.varAuthorName, type: 'string' },
      ],
    },
  ];
}

export function getHelpdeskAgentTools(tc: WorkflowConstantsTranslations): Array<{ name: string; label: string; description: string }> {
  return [
    { name: 'search_knowledge_base', label: tc.toolSearchKb, description: tc.toolSearchKbDesc },
    { name: 'escalate_to_human', label: tc.toolEscalate, description: tc.toolEscalateDesc },
    { name: 'get_conversation_history', label: tc.toolGetHistory, description: tc.toolGetHistoryDesc },
    { name: 'get_customer_info', label: tc.toolGetCustomer, description: tc.toolGetCustomerDesc },
  ];
}

export function getWorkflowChannels(tc: WorkflowConstantsTranslations): Array<{ value: string; label: string; icon: string }> {
  return [
    { value: 'web', label: tc.channelWeb, icon: 'Globe' },
    { value: 'email', label: tc.channelEmail, icon: 'Mail' },
    { value: 'chat', label: tc.channelLiveChat, icon: 'MessageCircle' },
    { value: 'discord', label: tc.channelDiscord, icon: 'MessageSquare' },
    { value: 'slack', label: tc.channelSlack, icon: 'MessageSquare' },
  ];
}

export function getWorkflowAudiences(tc: WorkflowConstantsTranslations): Array<{ value: string; label: string; icon: string }> {
  return [
    { value: 'leads', label: tc.audienceLeads, icon: 'UserPlus' },
    { value: 'users', label: tc.audienceUsers, icon: 'Users' },
    { value: 'visitors', label: tc.audienceVisitors, icon: 'Eye' },
  ];
}

export function getDynamicVariableGroupsTranslated(
  steps: Array<{ id: string; type: string; name: string; config?: Record<string, unknown> }>,
  currentStepIndex: number,
  tc: WorkflowConstantsTranslations,
): VariableGroup[] {
  const groups: VariableGroup[] = [];

  for (let i = 0; i < currentStepIndex; i++) {
    const step = steps[i];
    if (!step) continue;

    if (step.type === 'send_choices') {
      groups.push({
        id: `step_${step.id}`,
        label: step.name || tc.stepSendChoices,
        icon: <ListChecks className="h-4 w-4 text-cyan-500" />,
        variables: [
          { path: `steps.${step.id}.selectedValue`, label: tc.varSelectedValue, type: 'string' },
          { path: `steps.${step.id}.selectedLabel`, label: tc.varSelectedLabel, type: 'string' },
        ],
      });
    }

    if (step.type === 'collect_input') {
      const rawFields = (step.config?.fields) as Array<{ id: string; label: string }> | undefined;
      const fields = rawFields || [];
      groups.push({
        id: `step_${step.id}`,
        label: step.name || tc.stepCollectInput,
        icon: <ClipboardList className="h-4 w-4 text-cyan-500" />,
        variables: fields.map(f => ({
          path: `steps.${step.id}.${f.id}`,
          label: f.label || f.id,
          type: 'string' as const,
        })),
      });
    }
  }

  return groups;
}
