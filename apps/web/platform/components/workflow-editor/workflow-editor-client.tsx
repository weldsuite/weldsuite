
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { usePageAgentContext } from '@/components/weldagent-wrapper';
import { useDataEvent } from '@/lib/events/data-events';
import { automationKeys } from '@/hooks/queries/use-automation-queries';
import { workflowEditorKeys } from '@/hooks/use-workflow-editor-data';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Play,
  Save,
  Trash2,
  Settings,
  Zap,
  GitBranch,
  AlertCircle,
  Mail,
  Globe,
  Clock,
  Code,
  FileText,
  Package,
  RefreshCw,
  CheckCircle2,
  Plus,
  Repeat,
  Variable,
  Wand2,
  Pencil,
  Search,
  MessageSquare,
  Bell,
  Calendar,
  CalendarDays,
  GitMerge,
  Webhook,
  MousePointerClick,
  XCircle,
  Copy,
  Eye,
  EyeOff,
  X,
  PanelRightClose,
  GitPullRequest,
  AlignHorizontalDistributeCenter,
  History,
  UserPlus,
  Tag,
  CircleDot,
  ArrowUpCircle,
  Reply,
  StickyNote,
  Ticket,
  Shield,
  Star,
  Bot,
  UserCheck,
  MessageSquareText,
  ListChecks,
  ClipboardList,
  ArrowUpRight,
  Sparkles,
  Tags,
} from 'lucide-react';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Link, useRouter, useSearchParams } from '@/lib/router';
import { toast } from 'sonner';
import { useUpdateWorkflow, useTestWorkflow, useUpdateWorkflowStatus } from '@/hooks/queries/use-automation-queries';
import { ActionConfigForm } from './components/action-config-form';
import { GenerateWithAiDialog } from './components/generate-with-ai-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { GeneratedWorkflowDraft } from '@/hooks/queries/use-automation-queries';
import { WorkflowCanvas } from '@weldsuite/ui/components/workflow-canvas';
import {
  getConditionBranchIds,
  getMissingRequiredFields,
  isStepConfigured,
} from '@weldsuite/ui/components/workflow-canvas';
import { buildAllVariables } from '@weldsuite/ui/components/workflow-canvas/parts/variable-picker';
import { WorkflowTemplateDialog } from '@/app/weldconnect/components/workflow-template-dialog';
import { TriggerEmptyState } from './components/trigger-empty-state';
import { Label } from '@weldsuite/ui/components/label';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@weldsuite/ui/components/dialog';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface WorkflowEditorClientProps {
  workflow: any;
  actionTypes: any[];
  triggerTypes: any[];
  entityEvents: any[];
  emailAccounts?: Array<{ id: string; email: string; displayName?: string }>;
  workspaceMembers?: Array<{ id: string; name: string; email: string; avatar?: string }>;
  workflowVariables?: Array<{ name: string; type?: string }>;
  workflowsForChaining?: Array<{ id: string; name: string; status: string }>;
  webhookData?: {
    id: string;
    url: string;
    externalUrl: string | null;
    secret: string | null;
    isEnabled: boolean;
  } | null;
  basePath?: string;
  parentLabel?: string;
  parentHref?: string;
  listLabel?: string;
  allowedActionIds?: string[];
  editorHref?: string;
  replaceExecutionsTab?: { label: string; href: string; icon: any };
  triggerLocked?: boolean;
  extraVariableGroups?: Array<{
    id: string;
    label: string;
    icon: React.ReactNode;
    variables: Array<{
      path: string;
      label: string;
      type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
      description?: string;
    }>;
  }>;
  excludeVariableGroups?: string[];
  publishLabel?: string;
  onPublish?: () => Promise<{ success: boolean; error?: string }>;
  /** Hide the publish/start button entirely (e.g. for draft wizard flows) */
  hidePublish?: boolean;
  /** Hide the nav tabs (back button + Editor/Executions/Settings). Keeps Save/Publish buttons visible. Used when an external nav wraps the editor. */
  hideNavTabs?: boolean;
  /** When set to 'helpdesk', shows helpdesk-specific trigger types, entity events, and variables */
  module?: 'helpdesk' | 'general';
  /** Override the default sidebar action types shown in the add-action panel */
  actionItems?: SidebarActionType[];
  /** Ref to a DOM element where action buttons (Save/Test/Publish) will be portaled when hideNavTabs is true */
  actionsPortalRef?: React.RefObject<HTMLDivElement | null>;
  /** Called when dirty state changes (unsaved modifications) */
  onDirtyChange?: (isDirty: boolean) => void;
}

// Action type icons and colors
const ACTION_META: Record<string, { icon: any; color: string; bgColor: string }> = {
  send_email: { icon: Mail, color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-900/30' },
  http_request: { icon: Globe, color: 'text-purple-600', bgColor: 'bg-purple-100 dark:bg-purple-900/30' },
  condition: { icon: GitBranch, color: 'text-orange-600', bgColor: 'bg-orange-100 dark:bg-orange-900/30' },
  loop: { icon: RefreshCw, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30' },
  delay: { icon: Clock, color: 'text-gray-600 dark:text-gray-400', bgColor: 'bg-gray-100 dark:bg-secondary' },
  transform_data: { icon: Code, color: 'text-pink-600', bgColor: 'bg-pink-100 dark:bg-pink-900/30' },
  log_message: { icon: FileText, color: 'text-slate-600', bgColor: 'bg-slate-100 dark:bg-slate-800' },
  create_record: { icon: Package, color: 'text-green-600', bgColor: 'bg-green-100 dark:bg-green-900/30' },
  update_record: { icon: Settings, color: 'text-yellow-600', bgColor: 'bg-yellow-100 dark:bg-yellow-900/30' },
  set_variable: { icon: Code, color: 'text-indigo-600', bgColor: 'bg-indigo-100 dark:bg-indigo-900/30' },
  // Helpdesk actions
  assign_conversation: { icon: UserPlus, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
  tag_conversation: { icon: Tag, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
  change_conversation_status: { icon: CircleDot, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
  change_priority: { icon: ArrowUpCircle, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
  send_reply: { icon: Reply, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
  add_internal_note: { icon: StickyNote, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
  create_ticket_from_conversation: { icon: Ticket, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
  apply_sla: { icon: Shield, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
  trigger_csat: { icon: Star, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-900/30' },
  // Chat widget actions
  send_message: { icon: MessageSquareText, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30' },
  send_choices: { icon: ListChecks, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30' },
  collect_input: { icon: ClipboardList, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30' },
  // AI agent & manual step
  ai_agent: { icon: Bot, color: 'text-violet-600', bgColor: 'bg-violet-100 dark:bg-violet-900/30' },
  ai_generate: { icon: Sparkles, color: 'text-violet-600', bgColor: 'bg-violet-100 dark:bg-violet-900/30' },
  ai_classify: { icon: Tags, color: 'text-fuchsia-600', bgColor: 'bg-fuchsia-100 dark:bg-fuchsia-900/30' },
  manual_step: { icon: UserCheck, color: 'text-amber-600', bgColor: 'bg-amber-100 dark:bg-amber-900/30' },
};

function getActionMeta(type: string) {
  return ACTION_META[type] || { icon: Zap, color: 'text-primary', bgColor: 'bg-primary/10' };
}

function getTriggerWarningMessage(trigger: any, triggerType: string): string | null {
  if (!trigger || !triggerType) return 'No trigger configured';

  switch (triggerType) {
    case 'entity_event': {
      const missing = [];
      if (!trigger.entityType) missing.push('entity type');
      if (!trigger.eventType) missing.push('event type');
      return missing.length > 0 ? `Missing ${missing.join(' and ')}` : null;
    }
    case 'schedule': {
      const config = trigger.config || trigger;
      const scheduleType = config.scheduleType || trigger.scheduleType;
      if (!scheduleType) return 'Missing schedule type';
      if (scheduleType === 'recurring' && !(config.cronExpression || trigger.cronExpression)) return 'Missing cron expression';
      if (scheduleType === 'one_time' && !(config.executeAt || trigger.executeAt)) return 'Missing execution time';
      return null;
    }
    case 'workflow_complete': {
      const config = trigger.config || trigger;
      if (!(config.sourceWorkflowId || trigger.sourceWorkflowId)) return 'Missing source workflow';
      return null;
    }
    case 'manual':
      return null;
    default:
      return null;
  }
}

// Sidebar action types
interface SidebarActionType {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  category: 'communication' | 'data' | 'logic' | 'integration' | 'ai' | 'helpdesk';
}

const TASK_ACTION_TYPES: SidebarActionType[] = [
  { id: 'send_email', name: 'Send Email', description: 'Send an email message', icon: Mail, category: 'communication' },
  { id: 'send_notification', name: 'Send Notification', description: 'Send an in-app notification', icon: Bell, category: 'communication' },
  { id: 'create_record', name: 'Create Record', description: 'Create a new database record', icon: Plus, category: 'data' },
  { id: 'update_record', name: 'Update Record', description: 'Update an existing record', icon: Pencil, category: 'data' },
  { id: 'delete_record', name: 'Delete Record', description: 'Delete a record', icon: Trash2, category: 'data' },
  { id: 'query_data', name: 'Query Data', description: 'Search and filter records', icon: Search, category: 'data' },
  { id: 'set_variable', name: 'Set Variable', description: 'Store a value for later use', icon: Variable, category: 'data' },
  { id: 'transform_data', name: 'Transform Data', description: 'Transform and map data', icon: Wand2, category: 'data' },
  { id: 'condition', name: 'Condition', description: 'Branch based on a condition', icon: GitBranch, category: 'logic' },
  { id: 'loop', name: 'Loop', description: 'Repeat actions for each item', icon: Repeat, category: 'logic' },
  { id: 'delay', name: 'Delay', description: 'Wait for a specified time', icon: Clock, category: 'logic' },
  { id: 'manual_step', name: 'Manual Step', description: 'Wait for human approval or input', icon: UserCheck, category: 'logic' },
  { id: 'http_request', name: 'HTTP Request', description: 'Make an API request', icon: Globe, category: 'integration' },
  { id: 'run_script', name: 'Run Script', description: 'Execute custom JavaScript', icon: Code, category: 'integration' },
  // ai_generate + ai_classify are the only AI action types re-enabled after
  // the platform-wide AI teardown (apps/workers/workflow-worker/src/engine/actions/ai.ts).
  // ai_extract, ai_summarize, and ai_agent remain removed — no longer offered
  // in the action picker. Steps already configured with one of those types
  // still render (via ACTION_META / action-config-form.tsx), but show the
  // shared "AI unavailable" state instead of a working config form.
  { id: 'ai_generate', name: 'AI Generate', description: 'Generate content with AI', icon: Sparkles, category: 'ai' },
  { id: 'ai_classify', name: 'AI Classify', description: 'Classify text into categories with AI', icon: Tags, category: 'ai' },
];

const HELPDESK_ACTION_TYPES: SidebarActionType[] = [
  { id: 'assign_conversation', name: 'Assign Conversation', description: 'Route to agent or team', icon: UserPlus, category: 'helpdesk' },
  { id: 'tag_conversation', name: 'Tag Conversation', description: 'Add or remove tags', icon: Tag, category: 'helpdesk' },
  { id: 'change_conversation_status', name: 'Change Status', description: 'Close, snooze, reopen, or resolve', icon: CircleDot, category: 'helpdesk' },
  { id: 'change_priority', name: 'Change Priority', description: 'Update priority level', icon: ArrowUpCircle, category: 'helpdesk' },
  { id: 'send_reply', name: 'Send Reply', description: 'Send message in conversation', icon: Reply, category: 'helpdesk' },
  { id: 'add_internal_note', name: 'Add Internal Note', description: 'Add internal-only note', icon: StickyNote, category: 'helpdesk' },
  { id: 'create_ticket_from_conversation', name: 'Create Ticket', description: 'Convert conversation to ticket', icon: Ticket, category: 'helpdesk' },
  { id: 'apply_sla', name: 'Apply SLA', description: 'Attach SLA policy', icon: Shield, category: 'helpdesk' },
  { id: 'trigger_csat', name: 'Trigger CSAT', description: 'Send satisfaction survey', icon: Star, category: 'helpdesk' },
  // 'ai_auto_reply' and 'ai_agent' removed platform-wide — see note above.
  { id: 'send_message', name: 'Send Bot Message', description: 'Send a message to the customer in chat', icon: MessageSquareText, category: 'helpdesk' },
  { id: 'send_choices', name: 'Send Choices', description: 'Send multiple choice options to the customer', icon: ListChecks, category: 'helpdesk' },
  { id: 'collect_input', name: 'Collect Input', description: 'Ask the customer for information', icon: ClipboardList, category: 'helpdesk' },
  { id: 'condition', name: 'Condition', description: 'Branch based on a condition', icon: GitBranch, category: 'logic' },
  { id: 'delay', name: 'Delay', description: 'Wait for a specified time', icon: Clock, category: 'logic' },
  { id: 'manual_step', name: 'Manual Step', description: 'Wait for human approval or input', icon: UserCheck, category: 'logic' },
  { id: 'send_notification', name: 'Send Notification', description: 'Send an in-app notification', icon: Bell, category: 'communication' },
];

const categoryColors: Record<string, string> = {
  communication: 'text-blue-500',
  data: 'text-green-500',
  logic: 'text-amber-500',
  integration: 'text-pink-500',
  ai: 'text-violet-500',
  helpdesk: 'text-teal-500',
};

// Trigger type static metadata (icons/colors only — names resolved from i18n at runtime)
const TRIGGER_TYPE_META: Record<string, { icon: any; color: string }> = {
  entity_event: { icon: Zap, color: 'bg-purple-500' },
  schedule: { icon: Calendar, color: 'bg-blue-500' },
  workflow_complete: { icon: GitMerge, color: 'bg-orange-500' },
  webhook: { icon: Webhook, color: 'bg-pink-500' },
  manual: { icon: MousePointerClick, color: 'bg-gray-500' },
};
const TRIGGER_TYPE_IDS = ['entity_event', 'schedule', 'workflow_complete', 'webhook', 'manual'] as const;

// Helpdesk flat routing triggers (single-click selection)
const HELPDESK_ROUTING_TRIGGERS = [
  { id: 'msg_created', label: 'Customer sends a message', icon: MessageSquare, entityType: 'helpdesk_conversation_message', eventType: 'created' },
  { id: 'conv_created', label: 'New conversation', icon: MessageSquare, entityType: 'helpdesk_conversation', eventType: 'created' },
  { id: 'conv_assigned', label: 'Conversation assigned', icon: UserPlus, entityType: 'helpdesk_conversation', eventType: 'assigned' },
  { id: 'conv_status', label: 'Status changed', icon: CircleDot, entityType: 'helpdesk_conversation', eventType: 'status_changed' },
  { id: 'conv_priority', label: 'Priority changed', icon: ArrowUpCircle, entityType: 'helpdesk_conversation', eventType: 'priority_changed' },
  { id: 'conv_tagged', label: 'Conversation tagged', icon: Tag, entityType: 'helpdesk_conversation', eventType: 'tagged' },
  { id: 'conv_sla', label: 'SLA breached', icon: Shield, entityType: 'helpdesk_conversation', eventType: 'sla_breached' },
  { id: 'ticket_created', label: 'Ticket created', icon: Ticket, entityType: 'helpdesk_ticket', eventType: 'created' },
  { id: 'ticket_assigned', label: 'Ticket assigned', icon: UserPlus, entityType: 'helpdesk_ticket', eventType: 'assigned' },
  { id: 'ticket_status', label: 'Ticket status changed', icon: CircleDot, entityType: 'helpdesk_ticket', eventType: 'status_changed' },
  { id: 'ticket_priority', label: 'Ticket priority changed', icon: ArrowUpCircle, entityType: 'helpdesk_ticket', eventType: 'priority_changed' },
  { id: 'ticket_tagged', label: 'Ticket tagged', icon: Tag, entityType: 'helpdesk_ticket', eventType: 'tagged' },
  { id: 'ticket_sla', label: 'Ticket SLA breached', icon: Shield, entityType: 'helpdesk_ticket', eventType: 'sla_breached' },
];

// Cron preset static values (labels resolved from i18n at runtime)
const CRON_PRESET_VALUES: Record<string, string> = {
  every_5_min: '*/5 * * * *',
  every_hour: '0 * * * *',
  every_day_9am: '0 9 * * *',
  every_weekday_9am: '0 9 * * 1-5',
  every_monday_9am: '0 9 * * 1',
  first_of_month: '0 9 1 * *',
  custom: '',
};
const CRON_PRESET_IDS = ['every_5_min', 'every_hour', 'every_day_9am', 'every_weekday_9am', 'every_monday_9am', 'first_of_month', 'custom'] as const;

// Timezone options for schedule trigger
const TIMEZONE_OPTIONS = [
  { value: 'Europe/Amsterdam', label: 'Europe/Amsterdam' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'America/New_York', label: 'America/New York' },
  { value: 'America/Chicago', label: 'America/Chicago' },
  { value: 'America/Los_Angeles', label: 'America/Los Angeles' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'UTC', label: 'UTC' },
];

function getConfigSummary(actionType: string, config: Record<string, any>): string {
  switch (actionType) {
    case 'send_email':
      if (config.to && config.subject) return `To: ${config.to} • ${config.subject}`;
      if (config.to) return `To: ${config.to}`;
      return '';
    case 'http_request':
      if (config.method && config.url) return `${config.method} ${config.url}`;
      return '';
    case 'condition':
      if (config.field && config.operator) return `${config.field} ${config.operator} ${config.value || ''}`;
      return '';
    case 'delay':
      if (config.seconds) return `Wait ${config.seconds} seconds`;
      if (config.minutes) return `Wait ${config.minutes} minutes`;
      if (config.hours) return `Wait ${config.hours} hours`;
      return '';
    case 'log_message':
      if (config.message) return config.message.substring(0, 60) + (config.message.length > 60 ? '...' : '');
      return '';
    case 'create_record':
    case 'update_record':
      if (config.entityType || config.entity) return `Entity: ${config.entityType || config.entity}`;
      return '';
    default:
      return '';
  }
}

export function WorkflowEditorClient({
  workflow: initialWorkflow,
  actionTypes,
  triggerTypes,
  entityEvents,
  emailAccounts = [],
  workspaceMembers = [],
  workflowVariables = [],
  workflowsForChaining = [],
  webhookData,
  basePath = '/weldconnect/workflows',
  parentLabel = 'Task',
  parentHref = '/weldconnect',
  listLabel = 'Workflows',
  allowedActionIds,
  editorHref,
  replaceExecutionsTab,
  triggerLocked,
  extraVariableGroups,
  excludeVariableGroups,
  publishLabel,
  onPublish,
  hidePublish,
  hideNavTabs,
  module = 'general',
  actionItems,
  actionsPortalRef,
  onDirtyChange,
}: WorkflowEditorClientProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const tcd = t.weldconnect.triggerConfigDialog;
  const tg = t.weldconnect.generateWithAi;
  const st = useTranslations();

  useBreadcrumbs([
    { label: parentLabel, href: parentHref },
    { label: listLabel, href: basePath },
    { label: initialWorkflow.name },
  ]);

  // Publish this workflow as the WeldAgent panel's active entity, so prompts
  // like "rename this workflow" or "add a step" land on the right object.
  const wfStatus: string = String(initialWorkflow.status ?? 'draft').toLowerCase();
  const wfPrompts = t.weldconnect.workflowDetail.agentPrompts;
  usePageAgentContext({
    type: 'workflow',
    id: initialWorkflow.id,
    title: initialWorkflow.name,
    data: {
      status: wfStatus,
      triggerType:
        (initialWorkflow.triggers?.[0]?.type as string | undefined) ??
        (initialWorkflow.trigger?.type as string | undefined) ??
        null,
      stepCount: Array.isArray(initialWorkflow.steps) ? initialWorkflow.steps.length : 0,
      description: initialWorkflow.description ?? null,
    },
    suggestedTools: [
      'get_workflow',
      'update_workflow_metadata',
      'update_workflow_status',
      'add_workflow_step',
      'update_workflow_step',
      'remove_workflow_step',
      'update_workflow_trigger',
    ],
    suggestedPrompts: [
      wfPrompts.rename,
      wfPrompts.addStep,
      wfStatus === 'paused' ? wfPrompts.activate : wfPrompts.pause,
    ],
  });

  // Re-fetch the workflow when the agent (or anything else) mutates it.
  const agentInvalidateQc = useQueryClient();
  const workflowsChangedListener = useCallback(() => {
    agentInvalidateQc.invalidateQueries({ queryKey: automationKeys.workflow(initialWorkflow.id) });
    agentInvalidateQc.invalidateQueries({ queryKey: automationKeys.workflows() });
    agentInvalidateQc.invalidateQueries({ queryKey: workflowEditorKeys.workflow(initialWorkflow.id) });
  }, [agentInvalidateQc, initialWorkflow.id]);
  useDataEvent('workflows:changed', workflowsChangedListener);

  // Build translated category labels from locale
  const categoryLabels = useMemo(
    () => t.weldconnect.addNodePanel.categories as Record<string, string>,
    [t]
  );

  // Build translated action types (override name/description from locale)
  const translatedActionTypes = useMemo(() => {
    const actions = t.weldconnect.addNodePanel.actions as Record<string, { name: string; description: string }>;
    return TASK_ACTION_TYPES.map((a) => ({
      ...a,
      name: actions[a.id]?.name ?? a.name,
      description: actions[a.id]?.description ?? a.description,
    }));
  }, [t]);

  // Build translated helpdesk action types
  const translatedHelpdeskActionTypes = useMemo(() => {
    const actions = t.weldconnect.addNodePanel.actions as Record<string, { name: string; description: string }>;
    return HELPDESK_ACTION_TYPES.map((a) => ({
      ...a,
      name: actions[a.id]?.name ?? a.name,
      description: actions[a.id]?.description ?? a.description,
    }));
  }, [t]);

  // Build TRIGGER_TYPES from meta + locale
  const TRIGGER_TYPES = useMemo(() => {
    const types = tcd.types as Record<string, { name: string; description: string }>;
    return TRIGGER_TYPE_IDS.map((id) => ({
      id,
      name: types[id]?.name ?? id,
      description: types[id]?.description ?? '',
      ...TRIGGER_TYPE_META[id],
    }));
  }, [tcd]);

  // Build CRON_PRESETS from values + locale
  const CRON_PRESETS = useMemo(() => {
    const presets = tcd.schedule.presets as Record<string, string>;
    return CRON_PRESET_IDS.map((id) => ({
      id,
      label: presets[id] ?? id,
      cron: CRON_PRESET_VALUES[id] ?? '',
    }));
  }, [tcd]);

  const filteredActionTypes = useMemo(() => {
    const base = actionItems
      ? actionItems.map((a) => {
          const actions = t.weldconnect.addNodePanel.actions as Record<string, { name: string; description: string }>;
          return { ...a, name: actions[a.id]?.name ?? a.name, description: actions[a.id]?.description ?? a.description };
        })
      : (module === 'helpdesk' ? translatedHelpdeskActionTypes : translatedActionTypes);
    if (allowedActionIds) {
      return base.filter((a) => allowedActionIds.includes(a.id));
    }
    return base;
  }, [actionItems, allowedActionIds, module, translatedActionTypes, translatedHelpdeskActionTypes, t]);

  // Filter trigger types based on module
  const filteredTriggerTypes = useMemo(() => {
    if (module === 'helpdesk') {
      // Helpdesk only supports entity_event and manual triggers
      return TRIGGER_TYPES.filter((t) => t.id === 'entity_event' || t.id === 'manual');
    }
    return TRIGGER_TYPES;
  }, [module, TRIGGER_TYPES]);

  // Filter entity events based on module
  const filteredEntityEvents = useMemo(() => {
    if (module === 'helpdesk') {
      // Only show helpdesk entity types
      return entityEvents.filter((e: any) => e.category === 'Helpdesk');
    }
    return entityEvents;
  }, [module, entityEvents]);

  // Group entity types by category for the picker — the catalog now exposes
  // ~150 entity types, so a flat list would be unusable. Preserves the order
  // entities arrive in within each category.
  const groupedEntityEvents = useMemo(() => {
    const groups: Array<{ category: string; entities: any[] }> = [];
    const byCategory = new Map<string, any[]>();
    for (const entity of filteredEntityEvents) {
      const category = entity.category || 'Other';
      let bucket = byCategory.get(category);
      if (!bucket) {
        bucket = [];
        byCategory.set(category, bucket);
        groups.push({ category, entities: bucket });
      }
      bucket.push(entity);
    }
    return groups;
  }, [filteredEntityEvents]);

  // Build flat variable list for canvas inline autocomplete
  const canvasVariableItems = useMemo(
    () => extraVariableGroups ? buildAllVariables({ triggerType: initialWorkflow.triggers?.[0]?.type, workflowVariables, extraVariableGroups, excludeGroups: excludeVariableGroups }) : undefined,
    [initialWorkflow.triggers, workflowVariables, extraVariableGroups, excludeVariableGroups]
  );

  const router = useRouter();
  const searchParams = useSearchParams();
  const initialPanel = searchParams.get('panel');

  // Ensure triggers and steps are always arrays (handle null from database)
  const defaultTriggers = triggerLocked
    ? [{ id: 'trigger-enrollment', type: 'manual', name: 'Person Enrolled' }]
    : (initialWorkflow.triggers || []);
  const [workflow, setWorkflow] = useState({
    ...initialWorkflow,
    triggers: defaultTriggers,
    steps: initialWorkflow.steps || [],
  });
  const savedSnapshotRef = useRef(JSON.stringify({ triggers: defaultTriggers, steps: initialWorkflow.steps || [] }));
  const isDirty = JSON.stringify({ triggers: workflow.triggers, steps: workflow.steps }) !== savedSnapshotRef.current;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Warn on browser tab close / refresh when dirty
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const apiBasePath = module === 'helpdesk' ? '/helpdesk-workflows' : '/workflows';
  const updateWorkflowMutation = useUpdateWorkflow(apiBasePath);
  const testWorkflowMutation = useTestWorkflow();
  const updateStatusMutation = useUpdateWorkflowStatus(apiBasePath);
  const isSaving = updateWorkflowMutation.isPending || updateStatusMutation.isPending;
  const isTesting = testWorkflowMutation.isPending;
  const [editingStep, setEditingStep] = useState<any | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);

  // --- Validation: which steps / the trigger still need required config -----
  const incompleteStepIds = useMemo(
    () => new Set(workflow.steps.filter((s: any) => !isStepConfigured(s)).map((s: any) => s.id)),
    [workflow.steps],
  );
  const firstIncompleteStepIndex = useMemo(
    () => workflow.steps.findIndex((s: any) => !isStepConfigured(s)),
    [workflow.steps],
  );
  const triggerIssue = useMemo(
    () => (triggerLocked ? null : getTriggerWarningMessage(workflow.triggers?.[0], workflow.triggers?.[0]?.type || '')),
    [workflow.triggers, triggerLocked],
  );
  const incompleteCount = incompleteStepIds.size + (triggerIssue ? 1 : 0);
  const hasBlockingIssues = incompleteCount > 0;

  // Trigger panel state
  const [showTriggerPanel, setShowTriggerPanel] = useState(false);
  const [showRunsPanel, setShowRunsPanel] = useState(initialPanel === 'runs');
  const [showAddActionPanel, setShowAddActionPanel] = useState(false);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [pendingGeneratedDraft, setPendingGeneratedDraft] = useState<{
    workflow: GeneratedWorkflowDraft;
    warnings: string[];
  } | null>(null);
  const [triggerType, setTriggerType] = useState<string>(workflow.triggers?.[0]?.type || 'entity_event');
  const [triggerEntityType, setTriggerEntityType] = useState(workflow.triggers?.[0]?.entityType || '');
  const [triggerEventType, setTriggerEventType] = useState(workflow.triggers?.[0]?.eventType || '');

  // Schedule trigger state
  const [scheduleType, setScheduleType] = useState<'one_time' | 'recurring'>('recurring');
  const [scheduleCronPreset, setScheduleCronPreset] = useState('every_day_9am');
  const [scheduleCustomCron, setScheduleCustomCron] = useState('0 9 * * *');
  const [scheduleTimezone, setScheduleTimezone] = useState('Europe/Amsterdam');
  const [scheduleExecuteAt, setScheduleExecuteAt] = useState('');

  // Webhook trigger state
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);

  // Mobile sidebar state
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);

  // Track which node initiated the add step action
  const [addStepSourceNodeId, setAddStepSourceNodeId] = useState<string | null>(null);

  // Sub-agent picker state
  const [addSubAgentForStepId, setAddSubAgentForStepId] = useState<string | null>(null);
  const [editSubAgentId, setEditSubAgentId] = useState<string | null>(null);
  const { getClient } = useAppApiClient();
  // AI (and ai_agent_definitions) was removed platform-wide (2026-07-08). The
  // `ai_agent` step type can no longer be added or configured — its config
  // form already renders the shared "AI unavailable" state (see
  // action-config-form.tsx). These sub-agent queries stay wired for any
  // pre-existing steps that still reference the add/edit sub-agent dialogs,
  // but no longer hit the removed `/ai/agent-definitions` endpoint.
  const { data: savedAgents } = useQuery({
    queryKey: ['ai-agents-all'],
    queryFn: async (): Promise<Array<{ id: string; name: string; description?: string; moduleKey: string }>> => [],
    staleTime: Infinity,
  });

  // Fetch full agent definition when editing a sub-agent
  const { data: editSubAgentData } = useQuery({
    queryKey: ['ai-agent-detail', editSubAgentId],
    queryFn: async (): Promise<any> => undefined,
    enabled: false,
  });

  // Fetch MCP integration connections for sub-agent editing
  const { data: mcpConnections } = useQuery({
    queryKey: ['integration-connections-mcp'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: Array<{
        id: string;
        name: string;
        provider: string;
        status: string;
        settings: {
          discoveredTools?: Array<{ name: string; description: string }>;
          [key: string]: unknown;
        };
      }> }>('/integrations/connections');
      return (res.data || []).filter((c: any) => c.provider === 'mcp_server' && c.status === 'active');
    },
  });

  const [subAgentForm, setSubAgentForm] = useState<{
    name: string;
    description: string;
    systemPrompt: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    maxIterations: number;
    maxTotalTokens: number;
    enabledBuiltinTools: string[];
    integrationIds: string[];
    integrationToolPermissions: Record<string, string[]>;
    escalationRules: { escalateOnFailure: boolean; escalateOnMaxIterations: boolean };
  } | null>(null);

  // Populate form when agent data loads
  useEffect(() => {
    if (editSubAgentData && editSubAgentId) {
      setSubAgentForm({
        name: editSubAgentData.name || '',
        description: editSubAgentData.description || '',
        systemPrompt: editSubAgentData.systemPrompt || '',
        modelId: editSubAgentData.modelId || 'openai/gpt-4o',
        temperature: parseFloat(editSubAgentData.temperature) || 0.7,
        maxTokens: editSubAgentData.maxTokens || 1024,
        maxIterations: editSubAgentData.maxIterations || 10,
        maxTotalTokens: editSubAgentData.maxTotalTokens || 20000,
        enabledBuiltinTools: editSubAgentData.enabledBuiltinTools || [],
        integrationIds: editSubAgentData.integrationIds || [],
        integrationToolPermissions: editSubAgentData.integrationToolPermissions || {},
        escalationRules: {
          escalateOnFailure: editSubAgentData.escalationRules?.escalateOnFailure !== false,
          escalateOnMaxIterations: editSubAgentData.escalationRules?.escalateOnMaxIterations !== false,
        },
      });
    }
  }, [editSubAgentData, editSubAgentId]);

  const updateSubAgentMutation = useMutation({
    // AI has been removed platform-wide — sub-agent definitions can no
    // longer be saved. Short-circuit instead of hitting the removed
    // `/ai/agent-definitions` endpoint.
    mutationFn: async (_params: { id: string; data: any }): Promise<never> => {
      throw new Error('AI is currently unavailable');
    },
    onError: () => toast.error(tec.toasts.agentUpdateFailed),
  });

  // Branch editing state
  const [editingBranch, setEditingBranch] = useState<{
    branchNodeId: string;
    branchType: string;
    parentConditionId: string;
    parentConditionStepIndex: number;
  } | null>(null);

  // Close edit panel on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingStep) setEditingStep(null);
        if (editingBranch) setEditingBranch(null);
        if (showTriggerPanel) setShowTriggerPanel(false);
        if (showRunsPanel) setShowRunsPanel(false);
        if (showAddActionPanel) setShowAddActionPanel(false);
        setShowMobileSidebar(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editingStep, editingBranch, showTriggerPanel, showRunsPanel, showAddActionPanel]);

  // Sync the runs panel with the `panel` search param. The wizard-nav
  // "Executions" tab is a URL link to `?panel=runs`, but `showRunsPanel` only
  // reads the param via useState on first mount — so once the editor is
  // mounted, clicking the tab changed the URL and nothing opened. `searchParams`
  // is memoised on TanStack's search object, so this effect runs only when the
  // search actually changes (Editor <-> Executions tab switches), not every
  // render. Switching to runs also closes the other right-pane panels.
  useEffect(() => {
    const isRuns = searchParams.get('panel') === 'runs';
    setShowRunsPanel(isRuns);
    if (isRuns) {
      setShowTriggerPanel(false);
      setShowAddActionPanel(false);
      setEditingStep(null);
      setEditingBranch(null);
    }
  }, [searchParams]);

  // Auto-show mobile sidebar when a panel is opened
  useEffect(() => {
    if (editingStep || editingBranch || showTriggerPanel || showAddActionPanel) {
      setShowMobileSidebar(true);
    }
  }, [editingStep, editingBranch, showTriggerPanel, showAddActionPanel]);

  const handleSave = async () => {
    try {
      await updateWorkflowMutation.mutateAsync({
        id: workflow.id,
        data: {
          name: workflow.name,
          description: workflow.description,
          triggers: workflow.triggers,
          steps: workflow.steps,
        },
      });
      savedSnapshotRef.current = JSON.stringify({ triggers: workflow.triggers, steps: workflow.steps });
      toast.success(tec.toasts.workflowSaved);
    } catch (error) {
      toast.error(tec.toasts.saveFailed);
    }
  };

  const handleTest = () => {
    testWorkflowMutation.mutate({ id: workflow.id, testData: {} }, {
      onSuccess: () => {
        toast.success(tec.toasts.testStarted);
        router.push(`/weldconnect/executions?workflowId=${workflow.id}`);
      },
      onError: () => {
        toast.error(tec.toasts.testFailed);
      },
    });
  };

  const handlePublish = async () => {
    // Block publishing while any trigger/step is missing required config and
    // guide the user straight to the first thing they need to fill in.
    if (hasBlockingIssues) {
      jumpToFirstIssue();
      toast.error(
        incompleteCount === 1
          ? tec.publishGate.cannotPublishOne
          : tec.publishGate.cannotPublish.replace('{count}', String(incompleteCount)),
      );
      return;
    }
    await handleSave();
    if (onPublish) {
      const result = await onPublish();
      if (result.success) {
        toast.success(publishLabel ? st('sweep.weldflow.editorClient.publishLabelSuccess', { label: publishLabel }) : tec.toasts.workflowPublished);
      } else {
        toast.error(result.error || tec.toasts.publishFailed);
      }
    } else {
      updateStatusMutation.mutate({ id: workflow.id, status: 'active' }, {
        onSuccess: () => {
          toast.success(tec.toasts.workflowPublished);
        },
        onError: () => {
          toast.error(tec.toasts.publishFailed);
        },
      });
    }
  };

  // Load an AI-generated draft (see GenerateWithAiDialog) into local editor
  // state as UNSAVED changes — reuses the same `setWorkflow` setter as every
  // other in-editor mutation, so `isDirty` flips true automatically and the
  // canvas re-renders the new trigger/steps like any hand-built edit. Trigger
  // config is flattened onto the trigger object (in addition to staying
  // nested under `config`) because several code paths in this file
  // (getTriggerWarningMessage's entity_event case, handleSelectTrigger) read
  // top-level fields rather than `trigger.config.*` — flattening keeps the
  // generated draft passing through the exact same "Setup required"
  // validation as a manually-configured trigger.
  const applyGeneratedDraft = useCallback((draft: GeneratedWorkflowDraft) => {
    const flattenedTriggers: Array<Record<string, unknown>> = draft.triggers.map((trigger, i) => ({
      id: trigger.id || `trigger-${Date.now()}-${i}`,
      type: trigger.type,
      name: trigger.name,
      isEnabled: trigger.isEnabled ?? true,
      ...(trigger.config || {}),
    }));
    const mappedSteps = draft.steps.map((step, i) => ({
      id: step.id || `step-${Date.now()}-${i}`,
      type: step.type,
      name: step.name,
      description: step.description,
      config: step.config || {},
      order: i,
    }));

    setWorkflow((prev: any) => ({
      ...prev,
      name: draft.name || prev.name,
      description: draft.description ?? prev.description,
      triggers: flattenedTriggers,
      steps: mappedSteps,
    }));
    setEditingStep(null);
    setEditingBranch(null);
    setSelectedStepIndex(null);
    setShowTriggerPanel(false);
    setShowAddActionPanel(false);
    const firstTrigger = flattenedTriggers[0];
    if (firstTrigger) {
      const type = typeof firstTrigger.type === 'string' ? firstTrigger.type : 'entity_event';
      setTriggerType(type);
      setTriggerEntityType(typeof firstTrigger.entityType === 'string' ? firstTrigger.entityType : '');
      setTriggerEventType(typeof firstTrigger.eventType === 'string' ? firstTrigger.eventType : '');
    }
    toast.success(tg.successToast);
  }, [tg.successToast]);

  const handleGeneratedWorkflow = useCallback((draft: GeneratedWorkflowDraft, warnings: string[]) => {
    const hasExistingContent = workflow.triggers.length > 0 || workflow.steps.length > 0;
    if (hasExistingContent) {
      setPendingGeneratedDraft({ workflow: draft, warnings });
    } else {
      applyGeneratedDraft(draft);
    }
  }, [workflow.triggers.length, workflow.steps.length, applyGeneratedDraft]);

  const handleAddAction = useCallback((actionType: string) => {
    // Resolve user-friendly name from locale
    const actions = t.weldconnect.addNodePanel.actions as Record<string, { name: string; description: string }>;

    const newStep: any = {
      id: `step-${Date.now()}`,
      type: actionType,
      name: actions[actionType]?.name || actionType,
      config: {},
      order: workflow.steps.length,
      position: undefined, // Let flow editor auto-position
    };

    // Determine which branch the new step belongs to
    if (addStepSourceNodeId) {
      if (addStepSourceNodeId.includes('_branch_') ||
          addStepSourceNodeId.endsWith('_if') ||
          addStepSourceNodeId.endsWith('_if_not')) {
        // Adding directly from a branch node ("+" on If true / If false / multi-branch)
        newStep.parentBranchId = addStepSourceNodeId;
      } else {
        // Adding from a step that may itself be a branch child — inherit its branch
        const sourceStep = workflow.steps.find((s: any) => s.id === addStepSourceNodeId);
        if (sourceStep?.parentBranchId) {
          newStep.parentBranchId = sourceStep.parentBranchId;
        }
      }
    }

    const updatedSteps = [...workflow.steps, newStep];
    updatedSteps.forEach((step, i) => (step.order = i));

    setWorkflow({ ...workflow, steps: updatedSteps });
    setEditingStep(newStep);
    setAddStepSourceNodeId(null); // Clear after use
  }, [workflow, addStepSourceNodeId, t]);

  const handleUpdateStep = (stepId: string, data: any) => {
    setWorkflow({
      ...workflow,
      steps: workflow.steps.map((s: any) =>
        s.id === stepId ? { ...s, ...data } : s
      ),
    });
  };

  const handleUpdateConfig = useCallback((stepId: string, config: Record<string, any>) => {
    setWorkflow((prev: any) => ({
      ...prev,
      steps: prev.steps.map((s: any) =>
        s.id === stepId ? { ...s, config: { ...s.config, ...config } } : s
      ),
    }));
    // Also update editingStep if it's the same step
    setEditingStep((prev: any) =>
      prev?.id === stepId ? { ...prev, config: { ...prev.config, ...config } } : prev
    );
  }, []);

  const handleDeleteStep = useCallback((index: number) => {
    const stepToDelete = workflow.steps[index];
    if (!stepToDelete) return;

    // Recursively collect all step IDs that should be deleted
    const idsToDelete = new Set<string>();
    function collectDeletions(id: string, type: string, config?: any) {
      idsToDelete.add(id);
      if (type === 'condition') {
        const branchIds = getConditionBranchIds({ id, config });
        branchIds.forEach((branchId) => {
          workflow.steps.forEach((s: any) => {
            if (s.parentBranchId === branchId) {
              collectDeletions(s.id, s.type, s.config);
            }
          });
        });
      }
    }
    collectDeletions(stepToDelete.id, stepToDelete.type, stepToDelete.config);

    const updatedSteps = workflow.steps
      .filter((s: any) => !idsToDelete.has(s.id))
      .map((step: any, i: number) => ({ ...step, order: i }));
    setWorkflow((prev: any) => ({ ...prev, steps: updatedSteps }));
    setSelectedStepIndex(null);
    setEditingStep(null);
    setEditingBranch(null);
  }, [workflow.steps]);

  const handleSelectTrigger = useCallback(() => {
    // Open trigger panel for editing the first trigger
    if (workflow.triggers.length > 0) {
      const trigger = workflow.triggers[0];
      setTriggerType(trigger.type || 'entity_event');
      setTriggerEntityType(trigger.entityType || '');
      setTriggerEventType(trigger.eventType || '');

      // Load schedule settings if it's a schedule trigger
      if (trigger.type === 'schedule') {
        setScheduleType(trigger.scheduleType || 'recurring');
        setScheduleTimezone(trigger.timezone || 'Europe/Amsterdam');
        setScheduleExecuteAt(trigger.executeAt || '');
        if (trigger.cronExpression) {
          const preset = CRON_PRESETS.find((p) => p.cron === trigger.cronExpression);
          if (preset) {
            setScheduleCronPreset(preset.id);
          } else {
            setScheduleCronPreset('custom');
            setScheduleCustomCron(trigger.cronExpression);
          }
        }
      }
    } else {
      setTriggerType('entity_event');
      setTriggerEntityType('');
      setTriggerEventType('');
      setScheduleType('recurring');
      setScheduleCronPreset('every_day_9am');
      setScheduleCustomCron('0 9 * * *');
      setScheduleTimezone('Europe/Amsterdam');
      setScheduleExecuteAt('');
    }
    setShowTriggerPanel(true);
    setShowRunsPanel(false);
    setShowAddActionPanel(false);
    setEditingStep(null);
    setEditingBranch(null);
    setSelectedStepIndex(null);
  }, [workflow.triggers]);

  const handleSelectStep = useCallback((index: number) => {
    setSelectedStepIndex(index);
    setShowTriggerPanel(false);
    setShowRunsPanel(false);
    setShowAddActionPanel(false);
    setEditingBranch(null);
    const step = workflow.steps[index];
    if (step) {
      setEditingStep(step);
    }
  }, [workflow.steps]);

  // Open the first incomplete trigger/step so the user knows exactly what to fill.
  const jumpToFirstIssue = useCallback(() => {
    if (triggerIssue) {
      handleSelectTrigger();
    } else if (firstIncompleteStepIndex >= 0) {
      handleSelectStep(firstIncompleteStepIndex);
    }
    setShowMobileSidebar(true);
  }, [triggerIssue, firstIncompleteStepIndex, handleSelectTrigger, handleSelectStep]);

  const handleSelectBranch = useCallback((branchNodeId: string, branchType: string, parentConditionId: string, parentConditionStepIndex: number) => {
    setEditingBranch({ branchNodeId, branchType, parentConditionId, parentConditionStepIndex });
    setEditingStep(null);
    setSelectedStepIndex(null);
    setShowTriggerPanel(false);
    setShowRunsPanel(false);
    setShowAddActionPanel(false);
  }, []);

  const handleStepsChange = useCallback((updatedSteps: any[]) => {
    setWorkflow((prev: any) => ({ ...prev, steps: updatedSteps }));
  }, []);

  // Memoized so their identity is stable across renders — the canvas's
  // node-sync effect depends on these, and inline closures here forced a full
  // node-graph rebuild on every parent render (jitter when adding/editing
  // actions). Only state setters are referenced, so deps are empty.
  const handleAddStep = useCallback((sourceNodeId?: string) => {
    setEditingStep(null);
    setEditingBranch(null);
    setShowTriggerPanel(false);
    setShowRunsPanel(false);
    setShowAddActionPanel(true);
    setAddStepSourceNodeId(sourceNodeId || null);
  }, []);

  const handleDeselect = useCallback(() => {
    setEditingStep(null);
    setEditingBranch(null);
    setShowTriggerPanel(false);
    setShowAddActionPanel(false);
  }, []);

  const handleAddSubAgent = useCallback((stepId: string) => {
    setAddSubAgentForStepId(stepId);
  }, []);

  const handleEditSubAgent = useCallback((subAgentId: string) => {
    setEditSubAgentId(subAgentId);
    setSubAgentForm(null); // will be populated when query resolves
  }, []);

  const handleSelectSubAgent = useCallback((agentId: string, agentName: string) => {
    if (!addSubAgentForStepId) return;
    const step = workflow.steps.find((s: any) => s.id === addSubAgentForStepId);
    if (!step) return;
    const currentIds: string[] = (step.config as any)?.subAgentIds || [];
    const currentNames: Record<string, string> = (step.config as any)?.subAgentNames || {};
    handleUpdateConfig(addSubAgentForStepId, {
      subAgentIds: [...currentIds, agentId],
      subAgentNames: { ...currentNames, [agentId]: agentName },
    });
    setAddSubAgentForStepId(null);
  }, [addSubAgentForStepId, workflow.steps, handleUpdateConfig]);

  const sortedSteps = [...workflow.steps].sort((a: any, b: any) => (a.order || 0) - (b.order || 0));

  return (
    <div className="h-full flex flex-col bg-muted/30 overflow-hidden">
      {/* Header */}
      <div className={cn("bg-background border-b flex-shrink-0 relative z-10", hideNavTabs && "hidden")}>
        <div className="px-2 md:px-4 py-2">
          <div className="flex items-center justify-between">
            {!hideNavTabs ? (
            <div className="flex items-center gap-1 md:gap-2">
              <div className="relative group">
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "text-xs md:text-sm px-2 md:px-3",
                    !showRunsPanel ? "bg-muted/50 border-gray-300/70 dark:border-border" : "border-transparent bg-transparent hover:bg-accent"
                  )}
                  onClick={() => {
                    setShowRunsPanel(false);
                    router.replace(editorHref ?? `${basePath}/${workflow.id}/edit`, { scroll: false });
                  }}
                >
                  <GitPullRequest className="h-3 w-3 mr-0.5" />
                  {st('sweep.weldflow.editorClient.editorTab')}
                </Button>
                <div className={cn(
                  "absolute -bottom-[9px] left-0 right-0 h-0.5 transition-colors",
                  !showRunsPanel ? "bg-foreground" : "bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600"
                )} />
              </div>
              {module !== 'helpdesk' && (
                replaceExecutionsTab ? (
                <div className="relative group">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs md:text-sm px-2 md:px-3 border-transparent bg-transparent hover:bg-accent"
                    asChild
                  >
                    <Link href={replaceExecutionsTab.href}>
                      <replaceExecutionsTab.icon className="h-3 w-3 mr-0.5" />
                      {replaceExecutionsTab.label}
                    </Link>
                  </Button>
                  <div className="absolute -bottom-[9px] left-0 right-0 h-0.5 transition-colors bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600" />
                </div>
              ) : (
                <div className="relative group">
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "text-xs md:text-sm px-2 md:px-3",
                      showRunsPanel ? "bg-muted/50 border-gray-300/70 dark:border-border" : "border-transparent bg-transparent hover:bg-accent"
                    )}
                    onClick={() => {
                      setShowRunsPanel(true);
                      setShowTriggerPanel(false);
                      setEditingStep(null);
                      setEditingBranch(null);
                      setShowMobileSidebar(true);
                      router.replace(`${basePath}/${workflow.id}/edit?panel=runs`, { scroll: false });
                    }}
                  >
                    <History className="h-3 w-3 mr-0.5" />
                    {st('sweep.weldflow.editorClient.executionsTab')}
                  </Button>
                  <div className={cn(
                    "absolute -bottom-[9px] left-0 right-0 h-0.5 transition-colors",
                    showRunsPanel ? "bg-foreground" : "bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600"
                  )} />
                </div>
              ))}
              {module !== 'helpdesk' && (
              <div className="relative hidden sm:block">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs md:text-sm px-2 md:px-3"
                  asChild
                >
                  <Link href={`${basePath}/${workflow.id}/settings`}>
                    <Settings className="h-3 w-3 mr-0.5" />
                    {st('sweep.weldflow.editorClient.settingsTab')}
                  </Link>
                </Button>
              </div>
              )}
            </div>
            ) : <div />}

            <div className="flex items-center gap-1 md:gap-2">
              {/* Mobile sidebar toggle */}
              <Button
                variant="outline"
                size="sm"
                className="lg:hidden h-8 w-8 p-0"
                onClick={() => setShowMobileSidebar(!showMobileSidebar)}
              >
                <Settings className="h-4 w-4" />
              </Button>
              {module !== 'helpdesk' && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs md:text-sm px-2 md:px-3 hidden sm:flex"
                onClick={() => setShowGenerateDialog(true)}
              >
                <Sparkles className="h-3 w-3 mr-1" />
                {tg.button}
              </Button>
              )}
              {module !== 'helpdesk' && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs md:text-sm px-2 md:px-3 hidden sm:flex"
                onClick={handleTest}
                disabled={isTesting || workflow.steps.length === 0}
              >
                {st('sweep.weldflow.editorClient.test')}
              </Button>
              )}
              {!hidePublish && hasBlockingIssues && workflow.steps.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={jumpToFirstIssue}
                  title={tec.publishGate.chipTooltip}
                  className="hidden sm:flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
                >
                  <AlertCircle className="h-3.5 w-3.5" />
                  {tec.publishGate.needsSetup.replace('{count}', String(incompleteCount))}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="text-xs md:text-sm px-2 md:px-3"
                onClick={handleSave}
                disabled={isSaving}
              >
                {st('sweep.weldflow.editorClient.save')}
              </Button>
              {!hidePublish && (
              <Button
                size="sm"
                className="text-xs md:text-sm px-2 md:px-3"
                onClick={handlePublish}
                disabled={isSaving || workflow.steps.length === 0}
              >
                {publishLabel || st('sweep.weldflow.editorClient.publish')}
              </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Portal action buttons to external nav when hideNavTabs */}
      {hideNavTabs && actionsPortalRef?.current && createPortal(
        <>
          {module !== 'helpdesk' && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs md:text-sm px-2 md:px-3 hidden sm:flex"
              onClick={() => setShowGenerateDialog(true)}
            >
              <Sparkles className="h-3 w-3 mr-1" />
              {tg.button}
            </Button>
          )}
          {module !== 'helpdesk' && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs md:text-sm px-2 md:px-3 hidden sm:flex"
              onClick={handleTest}
              disabled={isTesting || workflow.steps.length === 0}
            >
              {st('sweep.weldflow.editorClient.test')}
            </Button>
          )}
          {!hidePublish && hasBlockingIssues && workflow.steps.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              onClick={jumpToFirstIssue}
              title={tec.publishGate.chipTooltip}
              className="hidden sm:flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              {tec.publishGate.needsSetup.replace('{count}', String(incompleteCount))}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="text-xs md:text-sm px-2 md:px-3"
            onClick={handleSave}
            disabled={isSaving}
          >
            {st('sweep.weldflow.editorClient.save')}
          </Button>
          {!hidePublish && (
            <Button
              size="sm"
              className="text-xs md:text-sm px-2 md:px-3"
              onClick={handlePublish}
              disabled={isSaving || workflow.steps.length === 0}
            >
              {publishLabel || st('sweep.weldflow.editorClient.publish')}
            </Button>
          )}
        </>,
        actionsPortalRef.current
      )}

      {/* Main Content - Flow Editor + Sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Flow Editor Canvas */}
        <div className="flex-1 relative overflow-hidden">
          {!triggerLocked && !workflow.triggers[0] && sortedSteps.length === 0 && !showTriggerPanel ? (
            <TriggerEmptyState
              onSelectType={(type) => {
                setTriggerType(type);
                setWorkflow((prev: any) => ({
                  ...prev,
                  triggers: [{ id: `trigger-${Date.now()}`, type, isEnabled: true }],
                }));
                setShowTriggerPanel(true);
                setShowRunsPanel(false);
                setShowAddActionPanel(false);
                setEditingStep(null);
                setEditingBranch(null);
              }}
            />
          ) : (
          <WorkflowCanvas
            trigger={workflow.triggers[0] || null}
            steps={sortedSteps}
            onSelectTrigger={handleSelectTrigger}
            onSelectStep={handleSelectStep}
            onSelectBranch={handleSelectBranch}
            onDeleteStep={handleDeleteStep}
            onStepsChange={handleStepsChange}
            onAddStep={handleAddStep}
            onUpdateConfig={handleUpdateConfig}
            onAddSubAgent={handleAddSubAgent}
            onEditSubAgent={handleEditSubAgent}
            onDeselect={handleDeselect}
            selectedNodeId={showTriggerPanel ? 'trigger' : editingBranch?.branchNodeId || editingStep?.id || null}
            showAddPlaceholder={showAddActionPanel}
            addStepSourceNodeId={addStepSourceNodeId}
            triggerLocked={triggerLocked}
            variableItems={canvasVariableItems}
            labels={t.weldconnect.flowEditor as any}
            onNotify={(level, msg) => toast[level](msg)}
            className="w-full h-full"
          />
          )}
        </div>

        {/* Right Sidebar - Actions Panel or Edit Panel */}
        <div className={cn(
          "bg-background flex flex-col z-50",
          // Mobile: full screen below header
          "fixed top-[105px] left-0 right-0 bottom-0 w-full transform transition-transform duration-200",
          // Desktop: side panel
          "lg:relative lg:top-0 lg:w-[399px] lg:border-l",
          showMobileSidebar ? "translate-y-0" : "translate-y-full lg:translate-y-0 lg:translate-x-0"
        )}>
          {showRunsPanel ? (
            // Runs Panel
            <>
              <div className="pl-4 py-3 pr-3 border-b flex items-center justify-between">
                <h3 className="font-semibold text-sm">{tec.runHistory.title}</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => { setShowRunsPanel(false); setShowMobileSidebar(false); }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex-1 flex flex-col">
                {/* Empty State */}
                <div className="flex-1 flex flex-col items-center justify-center px-4">
                  <div className="relative mb-4 scale-75">
                    {/* Dashed border illustration */}
                    <div className="relative py-4">
                      {/* Top row */}
                      <div className="flex gap-3 mb-3">
                        <div className="w-14 h-10 border border-dashed border-red-200 rounded-lg" />
                        <div className="w-24 h-10 border border-dashed border-red-200 rounded-lg" />
                      </div>
                      {/* Middle circle with X */}
                      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full border-2 border-red-200 bg-background flex items-center justify-center z-10">
                        <XCircle className="w-5 h-5 text-red-400" />
                      </div>
                      {/* Bottom row */}
                      <div className="flex gap-3">
                        <div className="w-20 h-10 border border-dashed border-red-200 rounded-lg" />
                        <div className="w-16 h-10 border border-dashed border-red-200 rounded-lg" />
                      </div>
                    </div>
                  </div>
                  <h4 className="text-base font-semibold mb-1">{tec.runHistory.noRuns}</h4>
                  <p className="text-sm text-muted-foreground text-center">
                    {tec.runHistory.noRunsYet}
                  </p>
                </div>

                {/* Overview Stats */}
                <div className="p-4 border-t">
                  <div className="grid grid-cols-2 gap-2">
                    {/* Completed */}
                    <div className="p-3 rounded-lg bg-green-50 border border-green-100">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-lg font-semibold text-green-700">0</span>
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      </div>
                      <p className="text-xs text-green-600">{tec.runHistory.completed}</p>
                    </div>
                    {/* Failed */}
                    <div className="p-3 rounded-lg bg-red-50 border border-red-100">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-lg font-semibold text-red-700">0</span>
                        <XCircle className="w-4 h-4 text-red-500" />
                      </div>
                      <p className="text-xs text-red-600">{tec.runHistory.failed}</p>
                    </div>
                    {/* In progress */}
                    <div className="p-3 rounded-lg bg-muted/50 border border-border">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-lg font-semibold">0</span>
                        <RefreshCw className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <p className="text-xs text-muted-foreground">{tec.runHistory.inProgress}</p>
                    </div>
                    {/* Avg. runtime */}
                    <div className="p-3 rounded-lg bg-muted/50 border border-border">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-lg font-semibold">-</span>
                        <Clock className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <p className="text-xs text-muted-foreground">{tec.runHistory.avgRuntime}</p>
                    </div>
                  </div>
                  {/* Credits consumed - full width */}
                  <div className="mt-2 p-3 rounded-lg bg-muted/50 border border-border">
                    <div className="flex items-center justify-between mb-1">
                      <div>
                        <span className="text-lg font-semibold">0</span>
                      </div>
                      <Settings className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <p className="text-xs text-muted-foreground">0 credits consumed / 250 included</p>
                  </div>
                </div>
              </div>
            </>
          ) : showTriggerPanel ? (
            // Trigger Panel
            <>
              <div className="p-3 border-b">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-md bg-purple-100 dark:bg-purple-900/30">
                      <Zap className="h-4 w-4 text-purple-600" />
                    </div>
                    <h3 className="font-semibold text-sm">{workflow.triggers.length > 0 ? tec.triggerPanel.editTrigger : tec.triggerPanel.addTrigger}</h3>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => {
                      setShowTriggerPanel(false);
                      setShowMobileSidebar(false);
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {(() => {
                const currentTrigger = workflow.triggers?.[0];
                const warning = getTriggerWarningMessage(currentTrigger, triggerType);
                if (!warning) return null;
                return (
                  <div className="mx-3 mt-3 p-2.5 rounded-lg bg-amber-50 dark:bg-muted border border-amber-200 dark:border-border">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-muted-foreground">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="text-xs">{warning}</span>
                    </div>
                  </div>
                );
              })()}
              <ScrollArea className="flex-1">
                {module === 'helpdesk' ? (
                  <div className="p-4 space-y-1">
                    <Label className="text-xs font-medium mb-2 block">{tec.triggerPanel.whenThisHappens}</Label>
                    {HELPDESK_ROUTING_TRIGGERS.map((rt) => {
                      const isSelected = triggerEntityType === rt.entityType && triggerEventType === rt.eventType;
                      const Icon = rt.icon;
                      return (
                        <Button
                          key={rt.id}
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setTriggerType('entity_event');
                            setTriggerEntityType(rt.entityType);
                            setTriggerEventType(rt.eventType);
                            const triggerData: any = {
                              type: 'entity_event',
                              isEnabled: true,
                              entityType: rt.entityType,
                              eventType: rt.eventType,
                              name: rt.label,
                            };
                            if (workflow.triggers.length > 0) {
                              setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
                            } else {
                              setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
                            }
                          }}
                          className={cn(
                            'flex items-center gap-3 w-full py-2.5 px-3 rounded-lg transition-all text-left',
                            isSelected
                              ? 'bg-teal-50 dark:bg-teal-950/40 ring-1 ring-teal-200 dark:ring-teal-800'
                              : 'hover:bg-muted'
                          )}
                        >
                          <Icon className={cn('w-4 h-4 flex-shrink-0', isSelected ? 'text-teal-600' : 'text-muted-foreground')} />
                          <span className={cn('text-sm', isSelected ? 'text-teal-700 dark:text-teal-300 font-medium' : '')}>{rt.label}</span>
                        </Button>
                      );
                    })}
                  </div>
                ) : (
                <div className="p-4 space-y-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{tcd.triggerTypeLabel}</Label>
                    <div className="space-y-1">
                      {filteredTriggerTypes.map((type) => {
                        const Icon = type.icon;
                        const isSelected = triggerType === type.id;
                        return (
                          <Button
                            key={type.id}
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              setTriggerType(type.id);
                              // Update workflow immediately
                              const triggerData: any = { type: type.id, isEnabled: true };
                              if (workflow.triggers.length > 0) {
                                setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
                              } else {
                                setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
                              }
                            }}
                            className={cn(
                              'flex items-center gap-3 py-2.5 -mx-4 px-4 transition-all text-left',
                              isSelected
                                ? 'bg-blue-50 dark:bg-blue-950/40'
                                : 'hover:bg-muted'
                            )}
                            style={{ width: 'calc(100% + 2rem)' }}
                          >
                            <div className={cn(
                              'w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0',
                              isSelected ? 'bg-blue-100 dark:bg-blue-900/40' : 'bg-muted'
                            )}>
                              <Icon className={cn(
                                'w-4 h-4',
                                isSelected ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'
                              )} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className={cn(
                                'text-sm font-medium',
                                isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-foreground'
                              )}>{type.name}</p>
                              <p className="text-xs text-muted-foreground truncate">{type.description}</p>
                            </div>
                          </Button>
                        );
                      })}
                    </div>
                  </div>

                  {triggerType === 'entity_event' && (
                    <div className="space-y-3 pt-3 border-t">
                      <div className="space-y-2">
                        <Label className="text-xs font-medium">{tcd.entityEvent.entityTypeLabel}</Label>
                        <Select value={triggerEntityType} onValueChange={(v) => {
                          setTriggerEntityType(v);
                          setTriggerEventType('');
                          // Update workflow immediately
                          const triggerData: any = { type: 'entity_event', entityType: v, eventType: '' };
                          if (workflow.triggers.length > 0) {
                            setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
                          } else {
                            setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
                          }
                        }}>
                          <SelectTrigger>
                            <SelectValue placeholder={tec.triggerPanel.selectEntityPlaceholder} />
                          </SelectTrigger>
                          <SelectContent>
                            {groupedEntityEvents.map((group) => (
                              <SelectGroup key={group.category}>
                                <SelectLabel>{group.category}</SelectLabel>
                                {group.entities.map((entity: any) => (
                                  <SelectItem key={entity.entityType} value={entity.entityType}>
                                    {entity.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {triggerEntityType && (
                        <div className="space-y-2">
                          <Label className="text-xs font-medium">{tcd.entityEvent.eventLabel}</Label>
                          <Select value={triggerEventType} onValueChange={(v) => {
                            setTriggerEventType(v);
                            // Update workflow immediately
                            const triggerData: any = { type: 'entity_event', entityType: triggerEntityType, eventType: v };
                            if (workflow.triggers.length > 0) {
                              setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
                            } else {
                              setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
                            }
                          }}>
                            <SelectTrigger>
                              <SelectValue placeholder={tec.triggerPanel.selectEventPlaceholder} />
                            </SelectTrigger>
                            <SelectContent>
                              {filteredEntityEvents.find((e: any) => e.entityType === triggerEntityType)?.events.map((event: any) => (
                                <SelectItem key={event.id} value={event.id}>
                                  {event.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  )}

                  {triggerType === 'schedule' && (
                    <div className="space-y-4 pt-3 border-t">
                      {/* Schedule Type */}
                      <div className="space-y-2">
                        <Label className="text-xs font-medium">{tcd.schedule.scheduleTypeLabel}</Label>
                        <RadioGroup
                          value={scheduleType}
                          onValueChange={(v) => {
                            const newType = v as 'one_time' | 'recurring';
                            setScheduleType(newType);
                            // Update workflow immediately
                            const cronExpression = scheduleCronPreset === 'custom'
                              ? scheduleCustomCron
                              : CRON_PRESETS.find((p) => p.id === scheduleCronPreset)?.cron || '0 9 * * *';
                            const triggerData: any = {
                              type: 'schedule',
                              scheduleType: newType,
                              ...(newType === 'one_time' ? { executeAt: scheduleExecuteAt } : { cronExpression }),
                              timezone: scheduleTimezone,
                            };
                            if (workflow.triggers.length > 0) {
                              setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
                            } else {
                              setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
                            }
                          }}
                          className="flex gap-4"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="one_time" id="one_time" />
                            <Label htmlFor="one_time" className="flex items-center gap-1.5 cursor-pointer text-sm">
                              <CalendarDays className="w-3.5 h-3.5" />
                              {tcd.schedule.oneTime}
                            </Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="recurring" id="recurring" />
                            <Label htmlFor="recurring" className="flex items-center gap-1.5 cursor-pointer text-sm">
                              <Repeat className="w-3.5 h-3.5" />
                              {tcd.schedule.recurring}
                            </Label>
                          </div>
                        </RadioGroup>
                      </div>

                      {/* One-time: Date/Time Picker */}
                      {scheduleType === 'one_time' && (
                        <div className="space-y-2">
                          <Label className="text-xs font-medium">{tcd.schedule.executeAtLabel}</Label>
                          <Input
                            type="datetime-local"
                            value={scheduleExecuteAt}
                            onChange={(e) => {
                              setScheduleExecuteAt(e.target.value);
                              const triggerData: any = {
                                type: 'schedule',
                                scheduleType: 'one_time',
                                executeAt: e.target.value,
                                timezone: scheduleTimezone,
                              };
                              if (workflow.triggers.length > 0) {
                                setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
                              } else {
                                setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
                              }
                            }}
                            className="text-sm"
                          />
                          <p className="text-xs text-muted-foreground">
                            {tcd.schedule.executeAtHint}
                          </p>
                        </div>
                      )}

                      {/* Recurring: Cron Preset */}
                      {scheduleType === 'recurring' && (
                        <>
                          <div className="space-y-2">
                            <Label className="text-xs font-medium">{tcd.schedule.scheduleLabel}</Label>
                            <Select
                              value={scheduleCronPreset}
                              onValueChange={(v) => {
                                setScheduleCronPreset(v);
                                const cron = v === 'custom'
                                  ? scheduleCustomCron
                                  : CRON_PRESETS.find((p) => p.id === v)?.cron || '0 9 * * *';
                                const triggerData: any = {
                                  type: 'schedule',
                                  scheduleType: 'recurring',
                                  cronExpression: cron,
                                  timezone: scheduleTimezone,
                                };
                                if (workflow.triggers.length > 0) {
                                  setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
                                } else {
                                  setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
                                }
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CRON_PRESETS.map((preset) => (
                                  <SelectItem key={preset.id} value={preset.id}>
                                    {preset.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          {/* Custom Cron Expression */}
                          {scheduleCronPreset === 'custom' && (
                            <div className="space-y-2">
                              <Label className="text-xs font-medium">{tcd.schedule.cronExpressionLabel}</Label>
                              <Input
                                value={scheduleCustomCron}
                                onChange={(e) => {
                                  setScheduleCustomCron(e.target.value);
                                  const triggerData: any = {
                                    type: 'schedule',
                                    scheduleType: 'recurring',
                                    cronExpression: e.target.value,
                                    timezone: scheduleTimezone,
                                  };
                                  if (workflow.triggers.length > 0) {
                                    setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
                                  } else {
                                    setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
                                  }
                                }}
                                placeholder="0 9 * * *"
                                className="font-mono text-sm"
                              />
                              <p className="text-xs text-muted-foreground">
                                {tcd.schedule.cronExpressionHint}
                              </p>
                            </div>
                          )}
                        </>
                      )}

                      {/* Timezone */}
                      <div className="space-y-2">
                        <Label className="text-xs font-medium">{tcd.schedule.timezoneLabel}</Label>
                        <Select
                          value={scheduleTimezone}
                          onValueChange={(v) => {
                            setScheduleTimezone(v);
                            const cronExpression = scheduleCronPreset === 'custom'
                              ? scheduleCustomCron
                              : CRON_PRESETS.find((p) => p.id === scheduleCronPreset)?.cron || '0 9 * * *';
                            const triggerData: any = {
                              type: 'schedule',
                              scheduleType,
                              ...(scheduleType === 'one_time' ? { executeAt: scheduleExecuteAt } : { cronExpression }),
                              timezone: v,
                            };
                            if (workflow.triggers.length > 0) {
                              setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
                            } else {
                              setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TIMEZONE_OPTIONS.map((tz) => (
                              <SelectItem key={tz.value} value={tz.value}>
                                {tz.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {triggerType === 'webhook' && (
                    <div className="pt-3 border-t space-y-4">
                      {webhookData ? (
                        <>
                          {/* Webhook URL */}
                          <div className="space-y-2">
                            <Label className="text-xs font-medium">{tec.triggerPanel.webhookUrlLabel}</Label>
                            <div className="flex gap-2">
                              <Input
                                value={webhookData.externalUrl || webhookData.url}
                                readOnly
                                className="font-mono text-xs bg-muted/50"
                              />
                              <Button
                                variant="outline"
                                size="icon"
                                className="flex-shrink-0"
                                onClick={() => {
                                  navigator.clipboard.writeText(webhookData.externalUrl || webhookData.url);
                                  toast.success(tec.toasts.urlCopied);
                                }}
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {tec.triggerPanel.webhookUrlHint}
                            </p>
                          </div>

                          {/* Webhook Secret */}
                          {webhookData.secret && (
                            <div className="space-y-2">
                              <Label className="text-xs font-medium">{tec.triggerPanel.webhookSecretLabel}</Label>
                              <div className="flex gap-2">
                                <Input
                                  type={showWebhookSecret ? 'text' : 'password'}
                                  value={webhookData.secret}
                                  readOnly
                                  className="font-mono text-xs bg-muted/50"
                                />
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="flex-shrink-0"
                                  onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                                >
                                  {showWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="flex-shrink-0"
                                  onClick={() => {
                                    navigator.clipboard.writeText(webhookData.secret!);
                                    toast.success(tec.toasts.secretCopied);
                                  }}
                                >
                                  <Copy className="h-4 w-4" />
                                </Button>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {tec.triggerPanel.webhookSecretHint}
                              </p>
                            </div>
                          )}

                          {/* Status indicator */}
                          <div className="p-3 bg-muted/50 rounded-lg">
                            <div className="flex items-center gap-2">
                              <div className={cn(
                                "w-2 h-2 rounded-full",
                                webhookData.isEnabled ? "bg-green-500" : "bg-gray-400"
                              )} />
                              <span className="text-xs text-muted-foreground">
                                {webhookData.isEnabled ? tec.triggerPanel.webhookActive : tec.triggerPanel.webhookDisabled}
                              </span>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="p-3 bg-muted/50 rounded-lg">
                          <p className="text-xs text-muted-foreground">
                            {tec.triggerPanel.webhookNoUrl}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {triggerType === 'manual' && (
                    <div className="pt-3 border-t">
                      <div className="p-3 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground">
                          {tec.triggerPanel.manualHint}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                )}
              </ScrollArea>
            </>
          ) : showAddActionPanel ? (
            // Add Action Panel
            <>
              <div className="pl-4 pt-3 pb-3 pr-3 border-b">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-base">{module === 'helpdesk' ? tec.addActionPanel.addAction : tec.addActionPanel.addStep}</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => {
                      setShowAddActionPanel(false);
                      setShowMobileSidebar(false);
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-4 space-y-3">
                  {(['communication', 'data', 'logic', 'integration', 'ai', 'helpdesk'] as const).map((category) => {
                    const actionsInCategory = filteredActionTypes.filter((a) => a.category === category);
                    if (actionsInCategory.length === 0) return null;
                    return (
                      <div key={category} className="space-y-1">
                        <Label className="text-xs font-medium">
                          {categoryLabels[category]}
                        </Label>
                        <div>
                          {actionsInCategory.map((action) => {
                            const Icon = action.icon;
                            return (
                              <Button
                                key={action.id}
                                type="button"
                                variant="ghost"
                                onClick={() => {
                                  handleAddAction(action.id);
                                  setShowAddActionPanel(false);
                                }}
                                className="flex items-center gap-3 py-2 -mx-4 px-4 transition-all text-left hover:bg-muted"
                                style={{ width: 'calc(100% + 2rem)' }}
                              >
                                <div className="w-8 h-8 rounded-md border border-border/70 flex items-center justify-center flex-shrink-0">
                                  <Icon className="w-4 h-4 text-muted-foreground" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-foreground">{action.name}</p>
                                  <p className="text-xs text-muted-foreground truncate">{action.description}</p>
                                </div>
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </>
          ) : editingBranch ? (
            // Branch Edit Panel
            (() => {
              const parentStep = workflow.steps[editingBranch.parentConditionStepIndex];
              const branchChildren = workflow.steps.filter((s: any) => s.parentBranchId === editingBranch.branchNodeId);
              const conditionExpression = parentStep?.config?.field
                ? `${parentStep.config.field} ${parentStep.config.operator || ''} ${parentStep.config.value || ''}`
                : parentStep?.config?.expression || '';

              // Branch display styling
              const branchStyleMap: Record<string, { bg: string; icon: any; iconColor: string; label: string; borderColor: string; description: string }> = {
                if: { bg: 'bg-green-100 dark:bg-green-900/30', icon: CheckCircle2, iconColor: 'text-green-600', label: 'If True', borderColor: 'border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900', description: 'Executes when the condition is true' },
                if_not: { bg: 'bg-gray-100 dark:bg-secondary', icon: X, iconColor: 'text-gray-500 dark:text-muted-foreground', label: 'If False', borderColor: 'border-gray-200 bg-gray-50 dark:bg-background/20 dark:border-border', description: 'Executes when the condition is false' },
                escalated: { bg: 'bg-amber-100 dark:bg-amber-900/30', icon: ArrowUpRight, iconColor: 'text-amber-600', label: 'Escalated', borderColor: 'border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900', description: 'Executes when the agent escalates to a human' },
                completed: { bg: 'bg-green-100 dark:bg-green-900/30', icon: CheckCircle2, iconColor: 'text-green-600', label: 'Completed', borderColor: 'border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900', description: 'Executes when the agent resolves the issue' },
                failed: { bg: 'bg-red-100 dark:bg-red-900/30', icon: XCircle, iconColor: 'text-red-600', label: 'Failed', borderColor: 'border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900', description: 'Executes when the agent encounters an error' },
              };
              const defaultBranchStyle = { bg: 'bg-gray-100 dark:bg-secondary', icon: GitBranch, iconColor: 'text-gray-500', label: editingBranch.branchType, borderColor: 'border-gray-200 bg-gray-50 dark:bg-background/20 dark:border-border', description: `Executes for "${editingBranch.branchType}" outcome` };
              const branchStyle = branchStyleMap[editingBranch.branchType] || defaultBranchStyle;
              const BranchIcon = branchStyle.icon;

              return (
                <>
                  <div className="p-3 border-b">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={cn('p-1.5 rounded-md', branchStyle.bg)}>
                          <BranchIcon className={cn('h-4 w-4', branchStyle.iconColor)} />
                        </div>
                        <h3 className="font-semibold text-sm">{branchStyle.label}</h3>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => {
                          setEditingBranch(null);
                          setShowMobileSidebar(false);
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <ScrollArea className="flex-1">
                    <div className="p-4 space-y-4">
                      {/* Condition Info */}
                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Parent Condition</Label>
                        <Button
                          variant="ghost"
                          onClick={() => handleSelectStep(editingBranch.parentConditionStepIndex)}
                          className="w-full text-left p-3 rounded-lg border border-border hover:border-amber-200 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-md bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                              <GitBranch className="w-3.5 h-3.5 text-amber-600" />
                            </div>
                            <span className="text-sm font-medium">{parentStep?.name || 'Condition'}</span>
                          </div>
                          {conditionExpression && (
                            <p className="text-xs text-muted-foreground mt-2 truncate">{conditionExpression}</p>
                          )}
                        </Button>
                      </div>

                      {/* Branch Description */}
                      <div className="space-y-2">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Branch</Label>
                        <div className={cn('p-3 rounded-lg border', branchStyle.borderColor)}>
                          <p className="text-sm font-medium">{branchStyle.description}</p>
                        </div>
                      </div>

                      {/* Child Steps */}
                      <div className="border-t pt-4">
                        <div className="flex items-center justify-between mb-3">
                          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Steps ({branchChildren.length})
                          </Label>
                        </div>

                        {branchChildren.length === 0 ? (
                          <div className="text-center py-6">
                            <p className="text-sm text-muted-foreground mb-3">{tec.addActionPanel.noStepsInBranch}</p>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setEditingBranch(null);
                                setShowAddActionPanel(true);
                                setAddStepSourceNodeId(editingBranch.branchNodeId);
                              }}
                            >
                              <Plus className="h-4 w-4 mr-0.5" />
                              {tec.addActionPanel.addStep}
                            </Button>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {branchChildren.map((childStep: any) => {
                              const meta = getActionMeta(childStep.type);
                              const Icon = meta.icon;
                              const stepIndex = workflow.steps.findIndex((s: any) => s.id === childStep.id);
                              return (
                                <Button
                                  key={childStep.id}
                                  variant="ghost"
                                  onClick={() => handleSelectStep(stepIndex)}
                                  className="w-full text-left p-3 rounded-lg border border-border hover:border-blue-200 transition-colors"
                                >
                                  <div className="flex items-center gap-2">
                                    <div className={cn('w-6 h-6 rounded-md flex items-center justify-center', meta.bgColor)}>
                                      <Icon className={cn('w-3.5 h-3.5', meta.color)} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium truncate">{childStep.name}</p>
                                      {getConfigSummary(childStep.type, childStep.config || {}) && (
                                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                                          {getConfigSummary(childStep.type, childStep.config || {})}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </Button>
                              );
                            })}
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full mt-2"
                              onClick={() => {
                                setEditingBranch(null);
                                setShowAddActionPanel(true);
                                setAddStepSourceNodeId(editingBranch.branchNodeId);
                              }}
                            >
                              <Plus className="h-4 w-4 mr-0.5" />
                              {tec.addActionPanel.addStep}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </ScrollArea>
                </>
              );
            })()
          ) : editingStep ? (
            // Edit Step Panel
            <>
              <div className="p-3 border-b">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {(() => {
                      const meta = getActionMeta(editingStep.type);
                      const Icon = meta.icon;
                      return (
                        <div className={cn('p-1.5 rounded-md', meta.bgColor)}>
                          <Icon className={cn('h-4 w-4', meta.color)} />
                        </div>
                      );
                    })()}
                    <h3 className="font-semibold text-sm">{tec.editStepPanel.editStep}</h3>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => {
                      setEditingStep(null);
                      setShowMobileSidebar(false);
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {(() => {
                const acf = t.weldconnect.actionConfigForm as Record<string, any>;
                const missing = getMissingRequiredFields(editingStep.type, editingStep.config || {});
                if (missing.length === 0) {
                  return (
                    <div className="mx-3 mt-3 p-2.5 rounded-lg bg-emerald-50 dark:bg-muted border border-emerald-200 dark:border-border">
                      <div className="flex items-center gap-2 text-emerald-700 dark:text-muted-foreground">
                        <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="text-xs">{tec.editStepPanel.allRequiredDone}</span>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="mx-3 mt-3 p-3 rounded-lg bg-amber-50 dark:bg-muted border border-amber-200 dark:border-border">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="text-xs font-medium">{tec.editStepPanel.requiredFieldsTitle}</span>
                    </div>
                    <p className="mt-1 text-xs text-amber-700/80 dark:text-muted-foreground">
                      {tec.editStepPanel.requiredFieldsHint}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {missing.map((m) => (
                        <span
                          key={m.labelKey}
                          className="inline-flex items-center rounded-md border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        >
                          {acf[m.labelKey] || m.labelKey}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })()}
              <ScrollArea className="flex-1">
                <div className="p-4 space-y-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{tec.editStepPanel.actionNameLabel}</Label>
                    <Input
                      value={editingStep.name}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setEditingStep({ ...editingStep, name: newName });
                        handleUpdateStep(editingStep.id, { name: newName });
                      }}
                      placeholder={tec.editStepPanel.actionNamePlaceholder}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{tec.editStepPanel.descriptionLabel}</Label>
                    <Textarea
                      value={editingStep.description || ''}
                      onChange={(e) => {
                        const newDescription = e.target.value;
                        setEditingStep({ ...editingStep, description: newDescription });
                        handleUpdateStep(editingStep.id, { description: newDescription });
                      }}
                      placeholder={tec.editStepPanel.descriptionPlaceholder}
                      rows={3}
                    />
                  </div>

                  <div className="border-t pt-4">
                    <h4 className="text-xs font-medium mb-3 text-muted-foreground uppercase tracking-wide">{tec.editStepPanel.settingsLabel}</h4>
                    <ActionConfigForm
                      actionType={editingStep.type}
                      config={editingStep.config || {}}
                      onChange={(config) => {
                        setEditingStep({ ...editingStep, config });
                        handleUpdateStep(editingStep.id, { config });
                      }}
                      emailAccounts={emailAccounts}
                      workspaceMembers={workspaceMembers}
                      workflowSteps={workflow.steps.map((s: any) => ({
                        id: s.id,
                        name: s.name,
                        type: s.type,
                      }))}
                      currentStepIndex={workflow.steps.findIndex((s: any) => s.id === editingStep.id)}
                      workflowVariables={workflowVariables}
                      triggerType={workflow.triggers?.[0]?.type}
                      extraVariableGroups={extraVariableGroups}
                      excludeGroups={excludeVariableGroups}
                    />
                  </div>
                </div>
              </ScrollArea>
              <div className="p-3">
                <Button
                  variant="outline"
                  className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    const stepIndex = workflow.steps.findIndex((s: any) => s.id === editingStep.id);
                    if (stepIndex !== -1) {
                      handleDeleteStep(stepIndex);
                      setEditingStep(null);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
                  {tec.editStepPanel.deleteStep}
                </Button>
              </div>
            </>
          ) : (
            // Workflow Overview Panel
            <>
              {/* Mobile header for overview panel */}
              <div className="p-3 border-b lg:hidden flex items-center justify-between">
                <h3 className="font-semibold text-sm">{tec.overviewPanel.workflowDetails}</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setShowMobileSidebar(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-4 space-y-4">
                  {/* Checklist Section */}
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold">{tec.overviewPanel.checklist}</h3>
                    <p className="text-xs text-muted-foreground">
                      {tec.overviewPanel.checklistDescription}
                    </p>
                  </div>

                  {/* Checklist Items - Show unconfigured trigger and steps */}
                  <div className="space-y-3">
                    {/* Trigger check */}
                    {!triggerLocked && triggerIssue && (
                      <Button
                        variant="ghost"
                        onClick={handleSelectTrigger}
                        className="w-full text-left p-3 rounded-lg border border-border hover:border-blue-200 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-md bg-blue-100 flex items-center justify-center">
                              <Zap className="w-3.5 h-3.5 text-blue-600" />
                            </div>
                            <span className="text-sm font-medium">
                              {workflow.triggers?.[0]?.type
                                ? TRIGGER_TYPES.find(tr => tr.id === workflow.triggers[0].type)?.name
                                : tec.overviewPanel.selectTrigger}
                            </span>
                          </div>
                          <span className="px-2 py-0.5 text-xs font-medium text-muted-foreground bg-muted border border-border rounded-md">
                            {tec.overviewPanel.triggerBadge}
                          </span>
                        </div>
                        <div className="my-3 border-t border-border" />
                        <div className="flex items-center gap-1.5 text-amber-600">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span className="text-xs">{tec.overviewPanel.triggerNeedsConfig}</span>
                        </div>
                      </Button>
                    )}

                    {/* Steps that need configuration */}
                    {workflow.steps.map((step: any, index: number) => {
                      const missing = getMissingRequiredFields(step.type, step.config || {});
                      if (missing.length === 0) return null;

                      const acf = t.weldconnect.actionConfigForm as Record<string, any>;
                      const missingLabels = missing.map((m) => acf[m.labelKey] || m.labelKey).join(', ');
                      const actionMeta = filteredActionTypes.find(a => a.id === step.type);
                      const Icon = actionMeta?.icon || Code;

                      return (
                        <Button
                          key={step.id}
                          variant="ghost"
                          onClick={() => handleSelectStep(index)}
                          className="w-full text-left p-3 rounded-lg border border-border hover:border-blue-200 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <div className="w-6 h-6 rounded-md bg-blue-100 flex items-center justify-center">
                                <Icon className="w-3.5 h-3.5 text-blue-600" />
                              </div>
                              <span className="text-sm font-medium">{step.name}</span>
                            </div>
                            <span className="px-2 py-0.5 text-xs font-medium text-muted-foreground bg-muted border border-border rounded-md">
                              {categoryLabels[actionMeta?.category || 'data']}
                            </span>
                          </div>
                          <div className="my-3 border-t border-border" />
                          <div className="flex items-start gap-1.5 text-amber-600">
                            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                            <span className="text-xs">
                              {tec.overviewPanel.missingFields.replace('{fields}', missingLabels)}
                            </span>
                          </div>
                        </Button>
                      );
                    })}

                    {/* All configured message */}
                    {(triggerLocked || !triggerIssue) &&
                      workflow.steps.length > 0 &&
                      workflow.steps.every((step: any) => isStepConfigured(step)) && (
                        <div className="flex items-center gap-2 px-3 py-[11px] rounded-lg border border-border text-muted-foreground">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          <span className="text-sm">{tec.overviewPanel.allStepsConfigured}</span>
                        </div>
                      )}
                  </div>
                </div>
              </ScrollArea>

              {/* Helpful Resources - Fixed at bottom */}
              <div className="p-4 border-t">
                <p className="text-xs text-muted-foreground mb-3">{tec.overviewPanel.helpfulResources}</p>
                <div className="grid grid-cols-2 gap-2">
                  <a
                    href="#"
                    className="p-3 rounded-lg border border-border hover:border-gray-300 dark:hover:border-border hover:bg-muted/50 transition-colors"
                  >
                    <p className="text-sm font-medium mb-1">{tec.overviewPanel.documentation}</p>
                    <p className="text-xs text-muted-foreground">
                      {tec.overviewPanel.documentationHint}
                    </p>
                  </a>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowTemplateDialog(true)}
                    className="p-3 rounded-lg border border-border hover:border-gray-300 dark:hover:border-border hover:bg-muted/50 transition-colors text-left"
                  >
                    <p className="text-sm font-medium mb-1">{tec.overviewPanel.templates}</p>
                    <p className="text-xs text-muted-foreground">
                      {tec.overviewPanel.templatesHint}
                    </p>
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <WorkflowTemplateDialog
        open={showTemplateDialog}
        onOpenChange={setShowTemplateDialog}
        onSelectTemplate={(template) => {
          if (template.id === 'blank') {
            // Reset to blank workflow
            setWorkflow((prev: any) => ({ ...prev, triggers: [], steps: [] }));
            setTriggerType('entity_event');
            setTriggerEntityType('');
            setTriggerEventType('');
            setEditingStep(null);
            setSelectedStepIndex(null);
            return;
          }

          if (template.trigger && template.steps) {
            // Apply template trigger and steps
            setWorkflow((prev: any) => ({
              ...prev,
              triggers: [template.trigger],
              steps: template.steps,
            }));

            // Update trigger panel state to match template
            const trigger = template.trigger;
            setTriggerType(trigger.type || 'entity_event');

            if (trigger.type === 'entity_event') {
              setTriggerEntityType(trigger.entityType || '');
              setTriggerEventType(trigger.eventType || '');
            } else if (trigger.type === 'schedule') {
              setScheduleType(trigger.scheduleType || 'recurring');
              setScheduleTimezone(trigger.timezone || 'Europe/Amsterdam');
              setScheduleExecuteAt(trigger.executeAt || '');
              if (trigger.cronExpression) {
                const preset = CRON_PRESETS.find((p) => p.cron === trigger.cronExpression);
                if (preset) {
                  setScheduleCronPreset(preset.id);
                } else {
                  setScheduleCronPreset('custom');
                  setScheduleCustomCron(trigger.cronExpression);
                }
              }
            }

            // Reset editing state
            setEditingStep(null);
            setSelectedStepIndex(null);
            setEditingBranch(null);
            setShowTriggerPanel(false);
            setShowAddActionPanel(false);
          }
        }}
      />

      {module !== 'helpdesk' && (
        <GenerateWithAiDialog
          open={showGenerateDialog}
          onOpenChange={setShowGenerateDialog}
          onApply={handleGeneratedWorkflow}
        />
      )}

      <ConfirmDialog
        open={!!pendingGeneratedDraft}
        onOpenChange={(open) => { if (!open) setPendingGeneratedDraft(null); }}
        title={tg.replaceConfirm.title}
        description={tg.replaceConfirm.description}
        confirmLabel={tg.replaceConfirm.confirm}
        cancelLabel={tg.replaceConfirm.cancel}
        onConfirm={() => {
          if (pendingGeneratedDraft) applyGeneratedDraft(pendingGeneratedDraft.workflow);
          setPendingGeneratedDraft(null);
        }}
      />

      {/* Sub-Agent Picker Dialog */}
      <Dialog open={!!addSubAgentForStepId} onOpenChange={(open) => { if (!open) setAddSubAgentForStepId(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tec.subAgentDialog.addSubAgent}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 max-h-[400px] overflow-y-auto">
            {(() => {
              const step = addSubAgentForStepId ? workflow.steps.find((s: any) => s.id === addSubAgentForStepId) : null;
              const currentSubIds: string[] = (step?.config as any)?.subAgentIds || [];
              const headAgentId = (step?.config as any)?.agentDefinitionId;
              const available = (savedAgents || []).filter(
                (a) => a.id !== headAgentId && !currentSubIds.includes(a.id)
              );
              if (available.length === 0) {
                return (
                  <p className="text-sm text-muted-foreground py-4 text-center col-span-2">
                    {tec.subAgentDialog.noAgentsAvailable}{' '}
                    <a href="/welddesk/weldagent" className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer">
                      {tec.subAgentDialog.createAgents}
                    </a>{' '}
                    {tec.subAgentDialog.createAgentsFirst}
                  </p>
                );
              }
              return available.map((agent) => (
                <Button
                  key={agent.id}
                  type="button"
                  variant="ghost"
                  onClick={() => handleSelectSubAgent(agent.id, agent.name)}
                  className="flex items-center gap-2.5 w-full rounded-md p-2.5 hover:bg-muted/80 transition-colors text-left"
                >
                  <Bot className="w-4 h-4 text-violet-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{agent.name}</p>
                    {agent.description && (
                      <p className="text-xs text-muted-foreground truncate">{agent.description}</p>
                    )}
                  </div>
                </Button>
              ));
            })()}
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Sub-Agent Dialog */}
      <Dialog
        open={!!editSubAgentId}
        onOpenChange={(open) => {
          if (!open) {
            setEditSubAgentId(null);
            setSubAgentForm(null);
          }
        }}
      >
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tec.subAgentDialog.editSubAgent}</DialogTitle>
          </DialogHeader>
          {subAgentForm ? (
            <div className="grid grid-cols-2 gap-6">
              {/* Left column */}
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.nameLabel} *</label>
                    <Input
                      value={subAgentForm.name}
                      onChange={(e) => setSubAgentForm({ ...subAgentForm, name: e.target.value })}
                      placeholder={tec.subAgentDialog.agentNamePlaceholder}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.descriptionLabel}</label>
                    <Input
                      value={subAgentForm.description}
                      onChange={(e) => setSubAgentForm({ ...subAgentForm, description: e.target.value })}
                      placeholder={tec.subAgentDialog.agentDescriptionPlaceholder}
                      className="mt-1"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.systemPromptLabel} *</label>
                  <Textarea
                    value={subAgentForm.systemPrompt}
                    onChange={(e) => setSubAgentForm({ ...subAgentForm, systemPrompt: e.target.value })}
                    placeholder={tec.subAgentDialog.systemPromptPlaceholder}
                    rows={6}
                    className="mt-1"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.modelLabel}</label>
                    <Select
                      value={subAgentForm.modelId}
                      onValueChange={(v) => setSubAgentForm({ ...subAgentForm, modelId: v })}
                    >
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">{tec.subAgentDialog.inheritFromParent}</SelectItem>
                        <SelectItem value="openai/gpt-4o">GPT-4o</SelectItem>
                        <SelectItem value="openai/gpt-4o-mini">GPT-4o Mini</SelectItem>
                        <SelectItem value="anthropic/claude-sonnet-4-20250514">Claude Sonnet 4</SelectItem>
                        <SelectItem value="anthropic/claude-3-5-haiku-latest">Claude Haiku</SelectItem>
                        <SelectItem value="google/gemini-2.0-flash">Gemini 2.0 Flash</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.temperatureLabel}</label>
                    <Input
                      type="number"
                      value={subAgentForm.temperature}
                      onChange={(e) => setSubAgentForm({ ...subAgentForm, temperature: parseFloat(e.target.value) || 0.7 })}
                      min={0}
                      max={2}
                      step={0.1}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.maxIterationsLabel}</label>
                    <Input
                      type="number"
                      value={subAgentForm.maxIterations}
                      onChange={(e) => setSubAgentForm({ ...subAgentForm, maxIterations: parseInt(e.target.value) || 10 })}
                      min={1}
                      max={50}
                      className="mt-1"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.maxTokensLabel}</label>
                    <Input
                      type="number"
                      value={subAgentForm.maxTokens}
                      onChange={(e) => setSubAgentForm({ ...subAgentForm, maxTokens: parseInt(e.target.value) || 1024 })}
                      min={100}
                      max={16384}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.tokenBudgetLabel}</label>
                    <Input
                      type="number"
                      value={subAgentForm.maxTotalTokens}
                      onChange={(e) => setSubAgentForm({ ...subAgentForm, maxTotalTokens: parseInt(e.target.value) || 20000 })}
                      min={1000}
                      max={100000}
                      step={1000}
                      className="mt-1"
                    />
                  </div>
                </div>
              </div>

              {/* Right column */}
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.toolsLabel}</label>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1.5">
                    {[
                      { name: 'search_knowledge_base', label: 'Search Knowledge Base' },
                      { name: 'escalate_to_human', label: 'Escalate to Human' },
                      { name: 'get_conversation_history', label: 'Get Conversation History' },
                      { name: 'get_customer_info', label: 'Get Customer Info' },
                      { name: 'get_order_status', label: 'Get Order Status' },
                      { name: 'search_tickets', label: 'Search Tickets' },
                      { name: 'send_message_to_customer', label: 'Send Message' },
                      { name: 'tag_conversation', label: 'Tag Conversation' },
                      { name: 'update_conversation_status', label: 'Update Status' },
                      { name: 'create_ticket', label: 'Create Ticket' },
                      { name: 'assign_conversation', label: 'Assign Conversation' },
                    ].map((tool) => (
                      <label key={tool.name} className="flex items-center gap-2 cursor-pointer py-1">
                        <Checkbox
                          checked={subAgentForm.enabledBuiltinTools.includes(tool.name)}
                          onCheckedChange={() => {
                            setSubAgentForm((prev) => {
                              if (!prev) return prev;
                              const tools = prev.enabledBuiltinTools.includes(tool.name)
                                ? prev.enabledBuiltinTools.filter((t) => t !== tool.name)
                                : [...prev.enabledBuiltinTools, tool.name];
                              return { ...prev, enabledBuiltinTools: tools };
                            });
                          }}
                        />
                        <span className="text-sm">{tool.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.escalationLabel}</label>
                  <div className="space-y-1 mt-1.5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={subAgentForm.escalationRules.escalateOnFailure}
                        onCheckedChange={(checked) =>
                          setSubAgentForm({ ...subAgentForm, escalationRules: { ...subAgentForm.escalationRules, escalateOnFailure: !!checked } })
                        }
                      />
                      <span className="text-sm">{tec.subAgentDialog.escalateOnError}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={subAgentForm.escalationRules.escalateOnMaxIterations}
                        onCheckedChange={(checked) =>
                          setSubAgentForm({ ...subAgentForm, escalationRules: { ...subAgentForm.escalationRules, escalateOnMaxIterations: !!checked } })
                        }
                      />
                      <span className="text-sm">{tec.subAgentDialog.escalateOnMaxIterations}</span>
                    </label>
                  </div>
                </div>

                {/* Integrations (MCP Servers) */}
                {(mcpConnections || []).length > 0 && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{tec.subAgentDialog.integrationsLabel}</label>
                    <div className="space-y-2 mt-1.5">
                      {(mcpConnections || []).map((conn) => {
                        const isEnabled = subAgentForm.integrationIds.includes(conn.id);
                        const discoveredTools = conn.settings?.discoveredTools || [];
                        const allowedTools = subAgentForm.integrationToolPermissions[conn.id] || [];
                        return (
                          <div key={conn.id} className="rounded-md border p-2.5 space-y-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <Checkbox
                                checked={isEnabled}
                                onCheckedChange={(checked) => {
                                  setSubAgentForm((prev) => {
                                    if (!prev) return prev;
                                    if (checked) {
                                      const allToolNames = discoveredTools.map((t: any) => t.name);
                                      return {
                                        ...prev,
                                        integrationIds: [...prev.integrationIds, conn.id],
                                        integrationToolPermissions: { ...prev.integrationToolPermissions, [conn.id]: allToolNames },
                                      };
                                    } else {
                                      const { [conn.id]: _, ...restPerms } = prev.integrationToolPermissions;
                                      return {
                                        ...prev,
                                        integrationIds: prev.integrationIds.filter((id) => id !== conn.id),
                                        integrationToolPermissions: restPerms,
                                      };
                                    }
                                  });
                                }}
                              />
                              <span className="text-sm font-medium">{conn.name}</span>
                              {isEnabled && discoveredTools.length > 0 && (
                                <span className="text-xs text-muted-foreground ml-auto">{allowedTools.length}/{discoveredTools.length}</span>
                              )}
                            </label>
                            {isEnabled && discoveredTools.length > 0 && (
                              <div className="ml-6 space-y-0.5">
                                {discoveredTools.map((tool: any) => (
                                  <label key={tool.name} className="flex items-center gap-2 cursor-pointer">
                                    <Checkbox
                                      checked={allowedTools.includes(tool.name)}
                                      onCheckedChange={(checked) => {
                                        setSubAgentForm((prev) => {
                                          if (!prev) return prev;
                                          const current = prev.integrationToolPermissions[conn.id] || [];
                                          const next = checked
                                            ? [...current, tool.name]
                                            : current.filter((t) => t !== tool.name);
                                          return {
                                            ...prev,
                                            integrationToolPermissions: { ...prev.integrationToolPermissions, [conn.id]: next },
                                          };
                                        });
                                      }}
                                    />
                                    <span className="text-xs">{tool.name}</span>
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-violet-500" />
            </div>
          )}
          {subAgentForm && (
            <DialogFooter>
              <Button variant="outline" onClick={() => { setEditSubAgentId(null); setSubAgentForm(null); }}>
                {tec.subAgentDialog.cancel}
              </Button>
              <Button
                onClick={() => {
                  if (!editSubAgentId || !subAgentForm) return;
                  if (!subAgentForm.name.trim() || !subAgentForm.systemPrompt.trim()) {
                    toast.error(tec.toasts.nameAndPromptRequired);
                    return;
                  }
                  updateSubAgentMutation.mutate({ id: editSubAgentId, data: subAgentForm });
                }}
                disabled={updateSubAgentMutation.isPending}
              >
                {updateSubAgentMutation.isPending ? tec.subAgentDialog.saving : tec.subAgentDialog.saveChanges}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
