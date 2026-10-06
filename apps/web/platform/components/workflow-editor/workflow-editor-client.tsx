
import React, { useState, useCallback, useEffect, useId, useMemo, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { usePageAgentContext } from '@/components/weldagent-wrapper';
import { useDataEvent } from '@/lib/events/data-events';
import { automationKeys } from '@/hooks/queries/use-automation-queries';
import { workflowEditorKeys, useRotateWebhookSecret, useDisableWebhookSignature } from '@/hooks/use-workflow-editor-data';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
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
  MessageCircle,
  Bell,
  Building2,
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
  GitPullRequest,
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
  Plug,
  Pause,
  Play,
} from 'lucide-react';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Link, useRouter, useSearchParams } from '@/lib/router';
import { toast } from 'sonner';
import { useUpdateWorkflow, useTestWorkflow, useUpdateWorkflowStatus } from '@/hooks/queries/use-automation-queries';
import { ActionConfigForm } from './components/action-config-form';
import { GenerateWithAiDialog } from './components/generate-with-ai-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { GeneratedWorkflowDraft, ActionType, TriggerType, EntityEvent } from '@/hooks/queries/use-automation-queries';
import { WorkflowCanvas } from '@weldsuite/ui/components/workflow-canvas';
import {
  getConditionBranchIds,
  getMissingRequiredFields,
  isBranchingStepType,
  isStepConfigured,
} from '@weldsuite/ui/components/workflow-canvas';
import type { WorkflowStep, TriggerConfig, WorkflowCanvasLabels, ConditionStepConfig } from '@weldsuite/ui/components/workflow-canvas';
import { buildAllVariables } from '@weldsuite/ui/components/workflow-canvas/parts/variable-picker';
import { WorkflowTemplateDialog } from '@/app/weldconnect/components/workflow-template-dialog';
import { getWorkflowIssueCodes, isUnsupportedWorkflowError } from '@/app/weldconnect/mvp';
import type { RecordFieldDef } from '@/app/weldconnect/record-fields';
import { TriggerEmptyState } from './components/trigger-empty-state';
import { RunsPanel } from './components/runs-panel';
import { TestRunDialog, type TestRunRequest } from './components/test-run-dialog';
import { isValidCronExpression, nextCronRun } from './lib/cron';
import { findUnknownVariables, getStepFormatIssues, isInsideLoop } from './lib/step-issues';
import { TriggerRecordFieldsProvider } from './lib/editor-field-context';
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
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@weldsuite/ui/components/dialog';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

/**
 * A workflow step's shape varies by `type` (send_email / http_request /
 * condition / delay / branch / ...), and the editor spreads, nests, and
 * mutates these freely while the user edits — so this stays a loose bag
 * with the handful of cross-type fields the shell itself reads, rather than
 * a discriminated union.
 */
export interface WorkflowStepBag extends Record<string, unknown> {
  id?: string;
  type?: string;
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  parentBranchId?: string;
}

/** Fill in `WorkflowStep`'s required fields for the shared canvas/validation helpers. */
function asWorkflowStep(s: WorkflowStepBag): WorkflowStep {
  return {
    ...s,
    id: s.id || '',
    type: s.type || '',
    name: s.name || '',
    config: s.config || {},
    inputs: (s.inputs as Record<string, unknown> | undefined) || {},
  };
}

/** Stable default so `canvasVariableItems` isn't rebuilt on every render. */
const NO_WORKFLOW_VARIABLES: Array<{ name: string; type?: string }> = [];

/** Fill in `TriggerConfig`'s required fields for `<WorkflowCanvas trigger={...} />`. */
function asTriggerConfig(t: WorkflowTriggerBag | undefined): TriggerConfig | null {
  if (!t) return null;
  return {
    id: (t.id as string | undefined) || 'trigger',
    type: (t.type as TriggerConfig['type']) || 'manual',
    name: (t.name as string | undefined) || '',
    isEnabled: (t.isEnabled as boolean | undefined) ?? true,
    config: (t.config as Record<string, unknown> | undefined) || {},
  };
}

/** Same rationale as `WorkflowStepBag` — trigger config shape varies by `type`. */
export type WorkflowTriggerBag = { type?: string } & Record<string, unknown>;

/**
 * The shell is mounted from three different domains (WeldConnect workflows,
 * WeldCRM sequences, WeldDesk workflows) whose backend row shapes differ.
 * This models only the fields the shell itself reads — everything else stays
 * in `steps`/`triggers` as opaque per-action-type config.
 */
export interface EditorWorkflow {
  id: string;
  name: string;
  status?: string | null;
  description?: string | null;
  triggers?: WorkflowTriggerBag[];
  /** Legacy single-trigger shape some callers still pass instead of `triggers[]`. */
  trigger?: WorkflowTriggerBag;
  steps?: WorkflowStepBag[];
}

// Entity-events API entries may carry bare strings or { id, name, description } objects.
type EntityEventDetail = string | { id: string; name: string; description?: string };

function getEntityEventId(event: EntityEventDetail): string {
  return typeof event === 'string' ? event : event.id;
}

function getEntityEventLabel(event: EntityEventDetail): string {
  if (typeof event === 'string') return humanizeEventType(event);
  return event.name || humanizeEventType(event.id);
}

// The entity-events endpoint may report bare type strings (e.g. "created") or
// richer objects with name/description from the dashboard catalog.
function humanizeEventType(eventType: string): string {
  return eventType.charAt(0).toUpperCase() + eventType.slice(1).replace(/_/g, ' ');
}

interface WorkflowEditorClientProps {
  workflow: EditorWorkflow;
  actionTypes: ActionType[];
  triggerTypes: TriggerType[];
  entityEvents: EntityEvent[];
  emailAccounts?: Array<{ id: string; email: string; displayName?: string }>;
  workspaceMembers?: Array<{ id: string; name: string; email: string; avatar?: string }>;
  workflowVariables?: Array<{ name: string; type?: string }>;
  workflowsForChaining?: Array<{ id: string; name: string; status: string }>;
  webhookData?: {
    id: string;
    url: string;
    externalUrl: string | null;
    secret: string | null;
    validateSignature: boolean;
    isEnabled: boolean;
  } | null;
  basePath?: string;
  parentLabel?: string;
  parentHref?: string;
  listLabel?: string;
  /** Restrict the add-step panel to these action types. */
  allowedActionIds?: readonly string[];
  /** Restrict the trigger pickers to these trigger types. */
  allowedTriggerTypes?: readonly string[];
  /** Restrict the schedule trigger to these modes (e.g. only `recurring`). */
  allowedScheduleTypes?: readonly ('one_time' | 'recurring')[];
  /**
   * Treat an existing trigger/step outside the allowed lists above as a
   * blocking issue (publish gate + checklist), e.g. a legacy step in a
   * workflow created before the lists were narrowed.
   */
  blockUnsupported?: boolean;
  /** Hide the "Generate with AI" button and the templates entry points. */
  hideTemplatesAndAi?: boolean;
  editorHref?: string;
  replaceExecutionsTab?: { label: string; href: string; icon: LucideIcon };
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
  /**
   * Show the workflow's status (Draft / Active / Paused) next to the action
   * buttons, offer Pause there, and make saving a live workflow an explicit
   * "Publish changes". Hosts with their own launch flow (`onPublish`) keep
   * the plain Save / Publish pair.
   */
  showStatus?: boolean;
  /**
   * The record fields an entity-event trigger delivers, per entity and event.
   * Feeds the variable picker (`trigger.record.<field>`), the unknown-variable
   * check and the Test dialog's sample record. Undefined result = unknown entity.
   */
  resolveRecordFields?: (entityType: string | undefined, eventType: string | undefined) => RecordFieldDef[] | undefined;
  /** Point out `{{variables}}` that resolve to nothing for this workflow (step panel + checklist). */
  flagUnknownVariables?: boolean;
  /** Pre-filled as the sample record's email in the Test dialog, so test mails reach the tester. */
  testerEmail?: string;
}

// Action type icons and colors
const ACTION_META: Record<string, { icon: LucideIcon; color: string; bgColor: string }> = {
  send_email: { icon: Mail, color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-900/30' },
  http_request: { icon: Globe, color: 'text-purple-600', bgColor: 'bg-purple-100 dark:bg-purple-900/30' },
  condition: { icon: GitBranch, color: 'text-orange-600', bgColor: 'bg-orange-100 dark:bg-orange-900/30' },
  loop: { icon: RefreshCw, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30' },
  delay: { icon: Clock, color: 'text-gray-600 dark:text-gray-400', bgColor: 'bg-gray-100 dark:bg-secondary' },
  transform_data: { icon: Code, color: 'text-pink-600', bgColor: 'bg-pink-100 dark:bg-pink-900/30' },
  log_message: { icon: FileText, color: 'text-slate-600', bgColor: 'bg-slate-100 dark:bg-slate-800' },
  create_record: { icon: Package, color: 'text-green-600', bgColor: 'bg-green-100 dark:bg-green-900/30' },
  update_record: { icon: Settings, color: 'text-yellow-600', bgColor: 'bg-yellow-100 dark:bg-yellow-900/30' },
  create_customer: { icon: Building2, color: 'text-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30' },
  create_contact: { icon: UserPlus, color: 'text-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30' },
  update_contact: { icon: UserCheck, color: 'text-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30' },
  post_chat_message: { icon: MessageCircle, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30' },
  create_task: { icon: ClipboardList, color: 'text-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30' },
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

// Trigger shape varies by `triggerType` (entity_event / schedule / workflow_complete
// each nest their fields differently, and some payloads flatten `config` onto the
// trigger itself) — this reads defensively across all of them.
type TriggerBag = Record<string, unknown> & { config?: Record<string, unknown> };

/** What a trigger is still missing; a key of `workflowEditorClient.triggerWarnings`. */
type TriggerWarning =
  | 'noTrigger'
  | 'missingEntityEvent'
  | 'missingScheduleType'
  | 'missingCron'
  | 'invalidCron'
  | 'missingExecuteAt'
  | 'missingSourceWorkflow'
  | 'missingIntegrationEvent';

type TriggerWarningCheck = (trigger: TriggerBag) => TriggerWarning | null;

function getEntityEventWarning(trigger: TriggerBag): TriggerWarning | null {
  return trigger.entityType && trigger.eventType ? null : 'missingEntityEvent';
}

function getScheduleWarning(trigger: TriggerBag): TriggerWarning | null {
  const config = trigger.config || trigger;
  const scheduleType = config.scheduleType || trigger.scheduleType;
  if (!scheduleType) return 'missingScheduleType';
  if (scheduleType === 'recurring') {
    const cron = config.cronExpression || trigger.cronExpression;
    if (!cron) return 'missingCron';
    // Saved as-is, a malformed expression simply never fires.
    if (typeof cron !== 'string' || !isValidCronExpression(cron)) return 'invalidCron';
  }
  if (scheduleType === 'one_time' && !(config.executeAt || trigger.executeAt)) return 'missingExecuteAt';
  return null;
}

function getWorkflowCompleteWarning(trigger: TriggerBag): TriggerWarning | null {
  const config = trigger.config || trigger;
  return config.sourceWorkflowId || trigger.sourceWorkflowId ? null : 'missingSourceWorkflow';
}

function getIntegrationEventWarning(trigger: TriggerBag): TriggerWarning | null {
  const config = trigger.config || trigger;
  const provider = trigger.provider || config.provider;
  const event = trigger.event || config.event;
  return provider && event ? null : 'missingIntegrationEvent';
}

// Trigger types without an entry (api, manual, unknown) never warn.
const TRIGGER_WARNING_CHECKS = new Map<string, TriggerWarningCheck>([
  ['entity_event', getEntityEventWarning],
  ['schedule', getScheduleWarning],
  ['workflow_complete', getWorkflowCompleteWarning],
  ['integration_event', getIntegrationEventWarning],
]);

function getTriggerWarning(trigger: TriggerBag | null | undefined, triggerType: string): TriggerWarning | null {
  if (!trigger || !triggerType) return 'noTrigger';
  return TRIGGER_WARNING_CHECKS.get(triggerType)?.(trigger) ?? null;
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
  { id: 'post_chat_message', name: 'Post Chat Message', description: 'Post a message to a WeldChat channel', icon: MessageCircle, category: 'communication' },
  { id: 'create_customer', name: 'Create Company', description: 'Add a company to WeldCRM', icon: Building2, category: 'data' },
  { id: 'create_contact', name: 'Create Contact', description: 'Add a person to WeldCRM', icon: UserPlus, category: 'data' },
  { id: 'update_contact', name: 'Update Contact', description: 'Change a person in WeldCRM', icon: UserCheck, category: 'data' },
  { id: 'create_task', name: 'Create Task', description: 'Create a project task in WeldFlow', icon: ClipboardList, category: 'data' },
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


// Trigger type static metadata (icons/colors only — names resolved from i18n at runtime)
const TRIGGER_TYPE_META: Record<string, { icon: LucideIcon; color: string }> = {
  entity_event: { icon: Zap, color: 'bg-purple-500' },
  integration_event: { icon: Plug, color: 'bg-indigo-500' },
  schedule: { icon: Calendar, color: 'bg-blue-500' },
  workflow_complete: { icon: GitMerge, color: 'bg-orange-500' },
  webhook: { icon: Webhook, color: 'bg-pink-500' },
  manual: { icon: MousePointerClick, color: 'bg-gray-500' },
  api: { icon: Code, color: 'bg-teal-500' },
};
const TRIGGER_TYPE_IDS = [
  'entity_event',
  'integration_event',
  'schedule',
  'workflow_complete',
  'webhook',
  'manual',
  'api',
] as const;

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

type ConfigSummarizer = (config: Record<string, unknown>) => string;

function summarizeSendEmail(config: Record<string, unknown>): string {
  if (!config.to) return '';
  return config.subject ? `To: ${config.to} • ${config.subject}` : `To: ${config.to}`;
}

function summarizeHttpRequest(config: Record<string, unknown>): string {
  return config.method && config.url ? `${config.method} ${config.url}` : '';
}

function summarizeCondition(config: Record<string, unknown>): string {
  return config.field && config.operator ? `${config.field} ${config.operator} ${config.value || ''}` : '';
}

function summarizeDelay(config: Record<string, unknown>): string {
  if (config.seconds) return `Wait ${config.seconds} seconds`;
  if (config.minutes) return `Wait ${config.minutes} minutes`;
  if (config.hours) return `Wait ${config.hours} hours`;
  return '';
}

function summarizeLogMessage(config: Record<string, unknown>): string {
  const message = config.message;
  if (typeof message !== 'string') return '';
  return message.substring(0, 60) + (message.length > 60 ? '...' : '');
}

function summarizeRecordAction(config: Record<string, unknown>): string {
  const entity = config.entityType || config.entity;
  return entity ? `Entity: ${entity}` : '';
}

function summarizeCreateCustomer(config: Record<string, unknown>): string {
  return typeof config.name === 'string' ? config.name : '';
}

function summarizeContact(config: Record<string, unknown>): string {
  const name = [config.firstName, config.lastName].filter((part) => typeof part === 'string' && part).join(' ');
  return name || (typeof config.email === 'string' ? config.email : '');
}

function summarizePostChatMessage(config: Record<string, unknown>): string {
  const message = typeof config.message === 'string' ? config.message : typeof config.content === 'string' ? config.content : '';
  return message.substring(0, 60) + (message.length > 60 ? '...' : '');
}

function summarizeTask(config: Record<string, unknown>): string {
  return typeof config.title === 'string' ? config.title : '';
}

const CONFIG_SUMMARIZERS = new Map<string, ConfigSummarizer>([
  ['send_email', summarizeSendEmail],
  ['http_request', summarizeHttpRequest],
  ['condition', summarizeCondition],
  ['delay', summarizeDelay],
  ['log_message', summarizeLogMessage],
  ['create_record', summarizeRecordAction],
  ['update_record', summarizeRecordAction],
  ['create_customer', summarizeCreateCustomer],
  ['create_contact', summarizeContact],
  ['update_contact', summarizeContact],
  ['post_chat_message', summarizePostChatMessage],
  ['create_task', summarizeTask],
]);

function getConfigSummary(actionType: string, config: Record<string, unknown>): string {
  return CONFIG_SUMMARIZERS.get(actionType)?.(config) ?? '';
}

// --- Reading an existing trigger back into the trigger panel's form state ---

function readIntegrationEventId(trigger: WorkflowTriggerBag): string {
  return (trigger.event as string | undefined)
    || (trigger.config as { event?: string } | undefined)?.event
    || '';
}

interface WorkflowCompleteSettings {
  sourceWorkflowId: string;
  triggerOn: 'success' | 'failure' | 'both';
  passOutput: boolean;
}

const DEFAULT_WORKFLOW_COMPLETE_SETTINGS: WorkflowCompleteSettings = {
  sourceWorkflowId: '',
  triggerOn: 'success',
  passOutput: false,
};

function readWorkflowCompleteSettings(trigger: WorkflowTriggerBag): WorkflowCompleteSettings {
  const cfg = (trigger.config as Record<string, unknown> | undefined) ?? {};
  return {
    sourceWorkflowId:
      (trigger.sourceWorkflowId as string | undefined)
      || (cfg.sourceWorkflowId as string | undefined)
      || '',
    triggerOn:
      (trigger.triggerOn as WorkflowCompleteSettings['triggerOn'] | undefined)
      || (cfg.triggerOn as WorkflowCompleteSettings['triggerOn'] | undefined)
      || 'success',
    passOutput:
      trigger.passOutput !== undefined
        ? Boolean(trigger.passOutput)
        : Boolean(cfg.passOutput),
  };
}

interface ScheduleSettings {
  scheduleType: 'recurring' | 'one_time';
  timezone: string;
  executeAt: string;
  /** Set only when the trigger has a cron expression: the matching preset, or 'custom'. */
  cronPresetId?: string;
  /** Set only when the cron expression matches no preset. */
  customCron?: string;
}

function readScheduleSettings(
  trigger: WorkflowTriggerBag,
  cronPresets: Array<{ id: string; cron: string }>,
): ScheduleSettings {
  const settings: ScheduleSettings = {
    scheduleType: (trigger.scheduleType as 'recurring' | 'one_time' | undefined) || 'recurring',
    timezone: (trigger.timezone as string | undefined) || 'Europe/Amsterdam',
    executeAt: (trigger.executeAt as string | undefined) || '',
  };
  const cronExpression = trigger.cronExpression as string | undefined;
  if (!cronExpression) return settings;
  const preset = cronPresets.find((p) => p.cron === cronExpression);
  if (preset) return { ...settings, cronPresetId: preset.id };
  return { ...settings, cronPresetId: 'custom', customCron: cronExpression };
}

// ---------------------------------------------------------------------------
// Sidebar / header building blocks. They were inlined in the editor's JSX;
// they live here as components so the editor itself only wires state.
// ---------------------------------------------------------------------------

type EditorModule = 'helpdesk' | 'general';

/** Shared ghost "X" button that closes a sidebar panel. */
function PanelCloseButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  const label = t.weldconnect.workflowEditorClient.closePanel;
  return (
    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClick} aria-label={label} title={label}>
      <X className="h-4 w-4" />
    </Button>
  );
}

const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
};

/** Draft / Active / Paused pill in the editor's action bar. */
function WorkflowStatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const label = (t.weldconnect.workflows.statuses as Record<string, string>)[status] ?? status;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 sm:px-2 py-1 text-xs font-medium text-muted-foreground"
      title={label}
    >
      <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status] ?? 'bg-muted-foreground/40')} />
      <span className="sr-only sm:not-sr-only">{label}</span>
    </span>
  );
}

interface EditorActionButtonsProps {
  module: EditorModule;
  hideTemplatesAndAi?: boolean;
  hidePublish?: boolean;
  hasBlockingIssues: boolean;
  stepCount: number;
  incompleteCount: number;
  isTesting: boolean;
  isSaving: boolean;
  publishLabel?: string;
  /** Workflow status when the host shows it (`showStatus`); undefined keeps the plain Save / Publish pair. */
  status?: string;
  isDirty: boolean;
  onGenerate: () => void;
  onTest: () => void;
  onJumpToIssue: () => void;
  onSave: () => unknown;
  onPublish: () => unknown;
  onPause: () => void;
}

/** Generate / Test / "needs setup" chip / Save / Publish. Rendered in the header or portaled to an external nav. */
function EditorActionButtons({
  module,
  hideTemplatesAndAi,
  hidePublish,
  hasBlockingIssues,
  stepCount,
  incompleteCount,
  isTesting,
  isSaving,
  publishLabel,
  status,
  isDirty,
  onGenerate,
  onTest,
  onJumpToIssue,
  onSave,
  onPublish,
  onPause,
}: EditorActionButtonsProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const tec = t.weldconnect.workflowEditorClient;
  const tg = t.weldconnect.generateWithAi;
  const isHelpdesk = module === 'helpdesk';
  // A live workflow has no draft copy: whatever is saved runs on the next
  // trigger. So there is no neutral "Save" while it is active, only an
  // explicit "Publish changes" (and Pause to take it offline first).
  const isLive = status === 'active';
  const testLabel = st('sweep.weldflow.editorClient.test');

  return (
    <>
      {!isHelpdesk && !hideTemplatesAndAi && (
        <Button
          variant="outline"
          size="sm"
          className="text-xs md:text-sm px-2 md:px-3 hidden sm:flex"
          onClick={onGenerate}
        >
          <Sparkles className="h-3 w-3 mr-1" />
          {tg.button}
        </Button>
      )}
      {status && <WorkflowStatusBadge status={status} />}
      {!isHelpdesk && (
        <Button
          variant="outline"
          size="sm"
          className="text-xs md:text-sm px-2 md:px-3"
          onClick={onTest}
          disabled={isTesting || stepCount === 0}
          aria-label={testLabel}
          title={testLabel}
        >
          <Play className="h-3 w-3 sm:hidden" />
          <span className="hidden sm:inline">{testLabel}</span>
        </Button>
      )}
      {!hidePublish && hasBlockingIssues && stepCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          onClick={onJumpToIssue}
          title={tec.publishGate.chipTooltip}
          className="hidden sm:flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
        >
          <AlertCircle className="h-3.5 w-3.5" />
          {tec.publishGate.needsSetup.replace('{count}', String(incompleteCount))}
        </Button>
      )}
      {isLive ? (
        <>
          <Button
            variant="outline"
            size="sm"
            className="text-xs md:text-sm px-2 md:px-3"
            onClick={onPause}
            disabled={isSaving}
            aria-label={tec.status.pause}
            title={tec.status.pauseHint}
          >
            <Pause className="h-3 w-3 sm:mr-1" />
            <span className="hidden sm:inline">{tec.status.pause}</span>
          </Button>
          <Button
            size="sm"
            className="text-xs md:text-sm px-2 md:px-3"
            onClick={onPublish}
            disabled={isSaving || stepCount === 0 || !isDirty}
            title={tec.status.liveHint}
          >
            <span className="sm:hidden">{st('sweep.weldflow.editorClient.publish')}</span>
            <span className="hidden sm:inline">{tec.status.publishChanges}</span>
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            className="text-xs md:text-sm px-2 md:px-3"
            onClick={onSave}
            disabled={isSaving}
          >
            {st('sweep.weldflow.editorClient.save')}
          </Button>
          {!hidePublish && (
            <Button
              size="sm"
              className="text-xs md:text-sm px-2 md:px-3"
              onClick={onPublish}
              disabled={isSaving || stepCount === 0}
            >
              {publishLabel || (status === 'paused' ? tec.status.resume : st('sweep.weldflow.editorClient.publish'))}
            </Button>
          )}
        </>
      )}
    </>
  );
}

/** Underline under the active header tab. */
function TabUnderline({ active }: { active: boolean }) {
  return (
    <div className={cn(
      "absolute -bottom-[9px] left-0 right-0 h-0.5 transition-colors",
      active ? "bg-foreground" : "bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600"
    )} />
  );
}

function tabButtonClassName(active: boolean): string {
  return cn(
    "text-xs md:text-sm px-2 md:px-3",
    active ? "bg-muted/50 border-gray-300/70 dark:border-border" : "border-transparent bg-transparent hover:bg-accent"
  );
}

interface ExecutionsTabProps {
  showRunsPanel: boolean;
  replaceExecutionsTab?: { label: string; href: string; icon: LucideIcon };
  onOpenRunsTab: () => void;
}

function ExecutionsTab({ showRunsPanel, replaceExecutionsTab, onOpenRunsTab }: ExecutionsTabProps) {
  const st = useTranslations();

  if (replaceExecutionsTab) {
    const ReplaceIcon = replaceExecutionsTab.icon;
    return (
      <div className="relative group">
        <Button
          variant="outline"
          size="sm"
          className="text-xs md:text-sm px-2 md:px-3 border-transparent bg-transparent hover:bg-accent"
          asChild
        >
          <Link href={replaceExecutionsTab.href}>
            <ReplaceIcon className="h-3 w-3 mr-0.5" />
            {replaceExecutionsTab.label}
          </Link>
        </Button>
        <TabUnderline active={false} />
      </div>
    );
  }

  return (
    <div className="relative group">
      <Button
        variant="outline"
        size="sm"
        className={tabButtonClassName(showRunsPanel)}
        onClick={onOpenRunsTab}
      >
        <History className="h-3 w-3 mr-0.5" />
        {st('sweep.weldflow.editorClient.executionsTab')}
      </Button>
      <TabUnderline active={showRunsPanel} />
    </div>
  );
}

interface EditorNavTabsProps extends ExecutionsTabProps {
  module: EditorModule;
  basePath: string;
  workflowId: string;
  onOpenEditorTab: () => void;
}

function EditorNavTabs({
  module,
  basePath,
  workflowId,
  showRunsPanel,
  replaceExecutionsTab,
  onOpenEditorTab,
  onOpenRunsTab,
}: EditorNavTabsProps) {
  const st = useTranslations();
  const showModuleTabs = module !== 'helpdesk';

  return (
    <div className="flex items-center gap-1 md:gap-2">
      <div className="relative group">
        <Button
          variant="outline"
          size="sm"
          className={tabButtonClassName(!showRunsPanel)}
          onClick={onOpenEditorTab}
        >
          <GitPullRequest className="h-3 w-3 mr-0.5" />
          {st('sweep.weldflow.editorClient.editorTab')}
        </Button>
        <TabUnderline active={!showRunsPanel} />
      </div>
      {showModuleTabs && (
        <ExecutionsTab
          showRunsPanel={showRunsPanel}
          replaceExecutionsTab={replaceExecutionsTab}
          onOpenRunsTab={onOpenRunsTab}
        />
      )}
      {showModuleTabs && (
        <div className="relative hidden sm:block">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs md:text-sm px-2 md:px-3"
            asChild
          >
            <Link href={`${basePath}/${workflowId}/settings`}>
              <Settings className="h-3 w-3 mr-0.5" />
              {st('sweep.weldflow.editorClient.settingsTab')}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

interface EditorHeaderProps {
  hideNavTabs?: boolean;
  nav: EditorNavTabsProps;
  actions: EditorActionButtonsProps;
  onToggleMobileSidebar: () => void;
}

function EditorHeader({ hideNavTabs, nav, actions, onToggleMobileSidebar }: EditorHeaderProps) {
  const { t } = useI18n();
  const detailsLabel = t.weldconnect.workflowEditorClient.overviewPanel.workflowDetails;
  return (
    <div className={cn("bg-background border-b flex-shrink-0 relative z-10", hideNavTabs && "hidden")}>
      <div className="px-2 md:px-4 py-2">
        <div className="flex items-center justify-between">
          {hideNavTabs ? <div /> : <EditorNavTabs {...nav} />}

          <div className="flex items-center gap-1 md:gap-2">
            {/* Mobile sidebar toggle */}
            <Button
              variant="outline"
              size="sm"
              className="lg:hidden h-8 w-8 p-0"
              onClick={onToggleMobileSidebar}
              aria-label={detailsLabel}
              title={detailsLabel}
            >
              <Settings className="h-4 w-4" />
            </Button>
            <EditorActionButtons {...actions} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trigger panel
// ---------------------------------------------------------------------------

type ScheduleMode = 'one_time' | 'recurring';
type WorkflowCompleteOn = 'success' | 'failure' | 'both';

interface CronPreset {
  id: string;
  label: string;
  cron: string;
}

interface TriggerTypeOption {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
}

type WebhookData = NonNullable<WorkflowEditorClientProps['webhookData']>;

/** The trigger panel's local form state, owned by the editor and shared with its sections. */
interface TriggerFormApi {
  triggerType: string;
  setTriggerType: (value: string) => void;
  triggerEntityType: string;
  setTriggerEntityType: (value: string) => void;
  triggerEventType: string;
  setTriggerEventType: (value: string) => void;
  integrationTriggerEventId: string;
  setIntegrationTriggerEventId: (value: string) => void;
  scheduleType: ScheduleMode;
  setScheduleType: (value: ScheduleMode) => void;
  scheduleCronPreset: string;
  setScheduleCronPreset: (value: string) => void;
  scheduleCustomCron: string;
  setScheduleCustomCron: (value: string) => void;
  scheduleTimezone: string;
  setScheduleTimezone: (value: string) => void;
  scheduleExecuteAt: string;
  setScheduleExecuteAt: (value: string) => void;
  sourceWorkflowId: string;
  setSourceWorkflowId: (value: string) => void;
  workflowCompleteTriggerOn: WorkflowCompleteOn;
  setWorkflowCompleteTriggerOn: (value: WorkflowCompleteOn) => void;
  workflowCompletePassOutput: boolean;
  setWorkflowCompletePassOutput: (value: boolean) => void;
  showWebhookSecret: boolean;
  setShowWebhookSecret: (value: boolean) => void;
}

type ApplyTriggerData = (triggerData: WorkflowTriggerBag) => void;

function resolveCronExpression(preset: string, customCron: string, cronPresets: CronPreset[]): string {
  return preset === 'custom'
    ? customCron
    : cronPresets.find((p) => p.id === preset)?.cron || '0 9 * * *';
}

type HelpdeskRoutingTrigger = (typeof HELPDESK_ROUTING_TRIGGERS)[number];

function HelpdeskTriggerList({ form, applyTriggerData }: { form: TriggerFormApi; applyTriggerData: ApplyTriggerData }) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;

  const handleSelect = (rt: HelpdeskRoutingTrigger) => {
    form.setTriggerType('entity_event');
    form.setTriggerEntityType(rt.entityType);
    form.setTriggerEventType(rt.eventType);
    applyTriggerData({
      type: 'entity_event',
      isEnabled: true,
      entityType: rt.entityType,
      eventType: rt.eventType,
      name: rt.label,
    });
  };

  return (
    <div className="p-4 space-y-1">
      <Label className="text-xs font-medium mb-2 block">{tec.triggerPanel.whenThisHappens}</Label>
      {HELPDESK_ROUTING_TRIGGERS.map((rt) => {
        const isSelected = form.triggerEntityType === rt.entityType && form.triggerEventType === rt.eventType;
        const Icon = rt.icon;
        return (
          <Button
            key={rt.id}
            type="button"
            variant="ghost"
            onClick={() => handleSelect(rt)}
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
  );
}

interface TriggerTypeListProps {
  types: TriggerTypeOption[];
  selectedType: string;
  onSelect: (typeId: string) => void;
}

function TriggerTypeList({ types, selectedType, onSelect }: TriggerTypeListProps) {
  const { t } = useI18n();
  const tcd = t.weldconnect.triggerConfigDialog;

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium">{tcd.triggerTypeLabel}</Label>
      <div className="space-y-1">
        {types.map((type) => {
          const Icon = type.icon;
          const isSelected = selectedType === type.id;
          return (
            <Button
              key={type.id}
              type="button"
              variant="ghost"
              onClick={() => onSelect(type.id)}
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
  );
}

interface EntityEventFieldsProps {
  form: TriggerFormApi;
  groupedEntityEvents: Array<{ category: string; entities: EntityEvent[] }>;
  filteredEntityEvents: EntityEvent[];
  applyTriggerData: ApplyTriggerData;
}

function EntityEventFields({ form, groupedEntityEvents, filteredEntityEvents, applyTriggerData }: EntityEventFieldsProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const tcd = t.weldconnect.triggerConfigDialog;

  const handleEntityTypeChange = (entityType: string) => {
    form.setTriggerEntityType(entityType);
    form.setTriggerEventType('');
    // Update workflow immediately
    applyTriggerData({ type: 'entity_event', entityType, eventType: '' });
  };

  const handleEventTypeChange = (eventType: string) => {
    form.setTriggerEventType(eventType);
    // Update workflow immediately
    applyTriggerData({ type: 'entity_event', entityType: form.triggerEntityType, eventType });
  };

  return (
    <div className="space-y-3 pt-3 border-t">
      <div className="space-y-2">
        <Label className="text-xs font-medium">{tcd.entityEvent.entityTypeLabel}</Label>
        <Select value={form.triggerEntityType} onValueChange={handleEntityTypeChange}>
          <SelectTrigger>
            <SelectValue placeholder={tec.triggerPanel.selectEntityPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {groupedEntityEvents.map((group) => (
              <SelectGroup key={group.category}>
                <SelectLabel>{group.category}</SelectLabel>
                {group.entities.map((entity) => (
                  <SelectItem key={entity.entityType} value={entity.entityType}>
                    {entity.label ?? entity.entityType}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      {form.triggerEntityType && (
        <div className="space-y-2">
          <Label className="text-xs font-medium">{tcd.entityEvent.eventLabel}</Label>
          <Select value={form.triggerEventType} onValueChange={handleEventTypeChange}>
            <SelectTrigger>
              <SelectValue placeholder={tec.triggerPanel.selectEventPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {filteredEntityEvents.find((e) => e.entityType === form.triggerEntityType)?.events.map((event) => {
                const eventId = getEntityEventId(event as EntityEventDetail);
                return (
                  <SelectItem key={eventId} value={eventId}>
                    {getEntityEventLabel(event as EntityEventDetail)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {form.triggerEventType === 'updated' && (
            <p className="text-xs text-muted-foreground">{tcd.entityEvent.updatedHint}</p>
          )}
        </div>
      )}
    </div>
  );
}

interface ScheduleFieldsProps {
  form: TriggerFormApi;
  cronPresets: CronPreset[];
  oneTimeScheduleAllowed: boolean;
  applyTriggerData: ApplyTriggerData;
}

function ScheduleFields({ form, cronPresets, oneTimeScheduleAllowed, applyTriggerData }: ScheduleFieldsProps) {
  const { t, language } = useI18n();
  const tcd = t.weldconnect.triggerConfigDialog;
  const { scheduleType, scheduleCronPreset, scheduleCustomCron, scheduleTimezone, scheduleExecuteAt } = form;
  const cronFieldId = useId();

  const activeCron = resolveCronExpression(scheduleCronPreset, scheduleCustomCron, cronPresets);
  const cronIsValid = isValidCronExpression(activeCron);
  // Recomputed on every edit of the panel, which is when a fresh "now" matters.
  const nextRun = useMemo(
    () => (scheduleType === 'recurring' ? nextCronRun(activeCron, scheduleTimezone, new Date()) : null),
    [scheduleType, activeCron, scheduleTimezone],
  );
  const nextRunText = nextRun?.toLocaleString(language, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: scheduleTimezone,
    timeZoneName: 'short',
  });

  const handleScheduleTypeChange = (value: string) => {
    const newType = value as ScheduleMode;
    form.setScheduleType(newType);
    // Update workflow immediately
    const cronExpression = resolveCronExpression(scheduleCronPreset, scheduleCustomCron, cronPresets);
    applyTriggerData({
      type: 'schedule',
      scheduleType: newType,
      ...(newType === 'one_time' ? { executeAt: scheduleExecuteAt } : { cronExpression }),
      timezone: scheduleTimezone,
    });
  };

  const handleExecuteAtChange = (executeAt: string) => {
    form.setScheduleExecuteAt(executeAt);
    applyTriggerData({
      type: 'schedule',
      scheduleType: 'one_time',
      executeAt,
      timezone: scheduleTimezone,
    });
  };

  const handleCronPresetChange = (preset: string) => {
    form.setScheduleCronPreset(preset);
    applyTriggerData({
      type: 'schedule',
      scheduleType: 'recurring',
      cronExpression: resolveCronExpression(preset, scheduleCustomCron, cronPresets),
      timezone: scheduleTimezone,
    });
  };

  const handleCustomCronChange = (cronExpression: string) => {
    form.setScheduleCustomCron(cronExpression);
    applyTriggerData({
      type: 'schedule',
      scheduleType: 'recurring',
      cronExpression,
      timezone: scheduleTimezone,
    });
  };

  const handleTimezoneChange = (timezone: string) => {
    form.setScheduleTimezone(timezone);
    const cronExpression = resolveCronExpression(scheduleCronPreset, scheduleCustomCron, cronPresets);
    applyTriggerData({
      type: 'schedule',
      scheduleType,
      ...(scheduleType === 'one_time' ? { executeAt: scheduleExecuteAt } : { cronExpression }),
      timezone,
    });
  };

  return (
    <div className="space-y-4 pt-3 border-t">
      {/* Schedule Type */}
      <div className={cn('space-y-2', !oneTimeScheduleAllowed && scheduleType !== 'one_time' && 'hidden')}>
        <Label className="text-xs font-medium">{tcd.schedule.scheduleTypeLabel}</Label>
        <RadioGroup
          value={scheduleType}
          onValueChange={handleScheduleTypeChange}
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
            onChange={(e) => handleExecuteAtChange(e.target.value)}
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
            <Select value={scheduleCronPreset} onValueChange={handleCronPresetChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {cronPresets.map((preset) => (
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
              <Label htmlFor={cronFieldId} className="text-xs font-medium">{tcd.schedule.cronExpressionLabel}</Label>
              <Input
                id={cronFieldId}
                value={scheduleCustomCron}
                onChange={(e) => handleCustomCronChange(e.target.value)}
                placeholder="0 9 * * *"
                aria-invalid={!cronIsValid}
                aria-describedby={`${cronFieldId}-hint`}
                className={cn('font-mono text-sm', !cronIsValid && 'border-destructive focus-visible:ring-destructive')}
              />
              <p
                id={`${cronFieldId}-hint`}
                className={cn('text-xs', cronIsValid ? 'text-muted-foreground' : 'text-destructive')}
              >
                {cronIsValid ? tcd.schedule.cronExpressionHint : tcd.schedule.cronInvalid}
              </p>
            </div>
          )}

          {cronIsValid && (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {nextRunText ? tcd.schedule.nextRun.replace('{time}', nextRunText) : tcd.schedule.noUpcomingRun}
            </p>
          )}
        </>
      )}

      {/* Timezone */}
      <div className="space-y-2">
        <Label className="text-xs font-medium">{tcd.schedule.timezoneLabel}</Label>
        <Select value={scheduleTimezone} onValueChange={handleTimezoneChange}>
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
  );
}

interface IntegrationEventFieldsProps {
  form: TriggerFormApi;
  integrationTriggers: TriggerType[];
  applyTriggerData: ApplyTriggerData;
}

function IntegrationEventFields({ form, integrationTriggers, applyTriggerData }: IntegrationEventFieldsProps) {
  const { t } = useI18n();
  const tcd = t.weldconnect.triggerConfigDialog;

  const handleEventChange = (eventId: string) => {
    form.setIntegrationTriggerEventId(eventId);
    const selected = integrationTriggers.find((trigger) => trigger.id === eventId);
    const provider =
      (selected as { provider?: string } | undefined)?.provider ??
      eventId.split('.')[0];
    applyTriggerData({
      type: 'integration_event',
      provider,
      event: eventId,
    });
  };

  return (
    <div className="space-y-3 pt-3 border-t">
      <div className="space-y-2">
        <Label className="text-xs font-medium">{tcd.integrationEvent.eventLabel}</Label>
        <Select value={form.integrationTriggerEventId} onValueChange={handleEventChange}>
          <SelectTrigger>
            <SelectValue placeholder={tcd.integrationEvent.eventPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {integrationTriggers.map((trigger) => (
              <SelectItem key={trigger.id} value={trigger.id}>
                {trigger.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {integrationTriggers.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {tcd.integrationEvent.noEvents}{' '}
            <Link href="/weldconnect/integrations" className="text-primary underline-offset-2 hover:underline">
              {t.weldconnect.breadcrumbs.integrations}
            </Link>
          </p>
        )}
        {form.integrationTriggerEventId && (
          <p className="text-xs text-muted-foreground">
            {integrationTriggers.find((trigger) => trigger.id === form.integrationTriggerEventId)?.description}
          </p>
        )}
      </div>
    </div>
  );
}

interface WorkflowCompleteFieldsProps {
  form: TriggerFormApi;
  workflowsForChaining: Array<{ id: string; name: string; status: string }>;
  applyTriggerData: ApplyTriggerData;
}

function WorkflowCompleteFields({ form, workflowsForChaining, applyTriggerData }: WorkflowCompleteFieldsProps) {
  const { t } = useI18n();
  const tcd = t.weldconnect.triggerConfigDialog;

  const applyWorkflowComplete = (overrides: Partial<{ sourceWorkflowId: string; triggerOn: WorkflowCompleteOn; passOutput: boolean }>) => {
    applyTriggerData({
      type: 'workflow_complete',
      sourceWorkflowId: form.sourceWorkflowId,
      triggerOn: form.workflowCompleteTriggerOn,
      passOutput: form.workflowCompletePassOutput,
      ...overrides,
    });
  };

  const handleSourceWorkflowChange = (sourceWorkflowId: string) => {
    form.setSourceWorkflowId(sourceWorkflowId);
    applyWorkflowComplete({ sourceWorkflowId });
  };

  const handleTriggerOnChange = (value: string) => {
    const triggerOn = value as WorkflowCompleteOn;
    form.setWorkflowCompleteTriggerOn(triggerOn);
    applyWorkflowComplete({ triggerOn });
  };

  const handlePassOutputChange = (passOutput: boolean) => {
    form.setWorkflowCompletePassOutput(passOutput);
    applyWorkflowComplete({ passOutput });
  };

  return (
    <div className="space-y-4 pt-3 border-t">
      <div className="space-y-2">
        <Label className="text-xs font-medium">{tcd.workflowComplete.sourceWorkflowLabel}</Label>
        <Select value={form.sourceWorkflowId} onValueChange={handleSourceWorkflowChange}>
          <SelectTrigger>
            <SelectValue placeholder={tcd.workflowComplete.sourceWorkflowPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {(workflowsForChaining).map((wf) => (
              <SelectItem key={wf.id} value={wf.id}>
                {wf.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {workflowsForChaining.length === 0 && (
          <p className="text-xs text-muted-foreground">{tcd.workflowComplete.noOtherWorkflows}</p>
        )}
        <p className="text-xs text-muted-foreground">{tcd.workflowComplete.sourceWorkflowHint}</p>
      </div>
      <div className="space-y-2">
        <Label className="text-xs font-medium">{tcd.workflowComplete.triggerOnLabel}</Label>
        <RadioGroup
          value={form.workflowCompleteTriggerOn}
          onValueChange={handleTriggerOnChange}
          className="flex flex-col gap-2"
        >
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="success" id="wc_success" />
            <Label htmlFor="wc_success" className="text-sm cursor-pointer">{tcd.workflowComplete.successOnly}</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="failure" id="wc_failure" />
            <Label htmlFor="wc_failure" className="text-sm cursor-pointer">{tcd.workflowComplete.failureOnly}</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="both" id="wc_both" />
            <Label htmlFor="wc_both" className="text-sm cursor-pointer">{tcd.workflowComplete.both}</Label>
          </div>
        </RadioGroup>
      </div>
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{tcd.workflowComplete.passOutputLabel}</p>
          <p className="text-xs text-muted-foreground">{tcd.workflowComplete.passOutputHint}</p>
        </div>
        <Switch
          checked={form.workflowCompletePassOutput}
          onCheckedChange={handlePassOutputChange}
        />
      </div>
    </div>
  );
}

function WebhookSecretField({ webhookSecret, form }: { webhookSecret: string; form: TriggerFormApi }) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium">{tec.triggerPanel.webhookSecretLabel}</Label>
      <div className="flex gap-2">
        <Input
          type={form.showWebhookSecret ? 'text' : 'password'}
          value={webhookSecret}
          readOnly
          className="font-mono text-xs bg-muted/50"
        />
        <Button
          variant="outline"
          size="icon"
          className="flex-shrink-0"
          onClick={() => form.setShowWebhookSecret(!form.showWebhookSecret)}
        >
          {form.showWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="flex-shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(webhookSecret);
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
  );
}

function WebhookDetails({
  webhookData,
  workflowId,
  form,
}: {
  webhookData: WebhookData;
  workflowId: string;
  form: TriggerFormApi;
}) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const rotateSecret = useRotateWebhookSecret(workflowId);
  const disableSignature = useDisableWebhookSignature(workflowId);
  const pending = rotateSecret.isPending || disableSignature.isPending;
  // `GET .../workflow/:id` never returns the secret (it's masked by design —
  // see services/weldconnect-mvp.ts). The ONLY place it's ever visible is the
  // one-time response of the rotate-secret call this toggle makes when
  // turning signing on, so it's held here, not read off `webhookData`.
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const handleSignatureToggle = async (checked: boolean) => {
    try {
      if (checked) {
        const result = await rotateSecret.mutateAsync({ webhookId: webhookData.id, enableSignature: true });
        setRevealedSecret(result.secret);
        toast.success(tec.toasts.signatureEnabled);
      } else {
        await disableSignature.mutateAsync(webhookData.id);
        setRevealedSecret(null);
        toast.success(tec.toasts.signatureDisabled);
      }
    } catch {
      toast.error(tec.toasts.signatureUpdateFailed);
    }
  };

  return (
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
              void navigator.clipboard.writeText(webhookData.externalUrl || webhookData.url);
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

      {/* Signature validation toggle — off by default; the unguessable URL is the credential. */}
      <div className="flex items-center justify-between gap-3 pt-2">
        <div className="space-y-0.5">
          <p className="text-xs font-medium">{tec.triggerPanel.webhookSignatureLabel}</p>
          <p className="text-xs text-muted-foreground">{tec.triggerPanel.webhookSignatureHint}</p>
        </div>
        <Switch checked={webhookData.validateSignature} disabled={pending} onCheckedChange={handleSignatureToggle} />
      </div>

      {/* Webhook Secret — shown once, right after signing is turned on. */}
      {revealedSecret && <WebhookSecretField webhookSecret={revealedSecret} form={form} />}

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
  );
}

function WebhookFields({
  webhookData,
  workflowId,
  form,
}: {
  webhookData: WebhookData | null | undefined;
  workflowId: string;
  form: TriggerFormApi;
}) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;

  return (
    <div className="pt-3 border-t space-y-4">
      {webhookData ? (
        <WebhookDetails webhookData={webhookData} workflowId={workflowId} form={form} />
      ) : (
        <div className="p-3 bg-muted/50 rounded-lg">
          <p className="text-xs text-muted-foreground">
            {tec.triggerPanel.webhookNoUrl}
          </p>
        </div>
      )}
    </div>
  );
}

function TriggerHint({ text }: { text: string }) {
  return (
    <div className="pt-3 border-t">
      <div className="p-3 bg-muted/50 rounded-lg">
        <p className="text-xs text-muted-foreground">
          {text}
        </p>
      </div>
    </div>
  );
}

interface TriggerPanelProps {
  module: EditorModule;
  hasTrigger: boolean;
  warning: TriggerWarning | null;
  filteredTriggerTypes: TriggerTypeOption[];
  groupedEntityEvents: Array<{ category: string; entities: EntityEvent[] }>;
  filteredEntityEvents: EntityEvent[];
  integrationTriggers: TriggerType[];
  workflowsForChaining: Array<{ id: string; name: string; status: string }>;
  webhookData: WebhookData | null | undefined;
  /** Needed by the webhook signature toggle (rotate-secret / disable-signing calls). */
  workflowId: string;
  cronPresets: CronPreset[];
  oneTimeScheduleAllowed: boolean;
  form: TriggerFormApi;
  initialTriggerData: (type: string) => WorkflowTriggerBag;
  applyTriggerData: ApplyTriggerData;
  onClose: () => void;
}

/** The per-type settings shown under the trigger type list. */
function TriggerTypeDetails({
  filteredEntityEvents,
  groupedEntityEvents,
  integrationTriggers,
  workflowsForChaining,
  webhookData,
  workflowId,
  cronPresets,
  oneTimeScheduleAllowed,
  form,
  applyTriggerData,
}: Omit<TriggerPanelProps, 'module' | 'hasTrigger' | 'warning' | 'filteredTriggerTypes' | 'initialTriggerData' | 'onClose'>) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const tcd = t.weldconnect.triggerConfigDialog;

  switch (form.triggerType) {
    case 'entity_event':
      return (
        <EntityEventFields
          form={form}
          groupedEntityEvents={groupedEntityEvents}
          filteredEntityEvents={filteredEntityEvents}
          applyTriggerData={applyTriggerData}
        />
      );
    case 'schedule':
      return (
        <ScheduleFields
          form={form}
          cronPresets={cronPresets}
          oneTimeScheduleAllowed={oneTimeScheduleAllowed}
          applyTriggerData={applyTriggerData}
        />
      );
    case 'integration_event':
      return <IntegrationEventFields form={form} integrationTriggers={integrationTriggers} applyTriggerData={applyTriggerData} />;
    case 'workflow_complete':
      return <WorkflowCompleteFields form={form} workflowsForChaining={workflowsForChaining} applyTriggerData={applyTriggerData} />;
    case 'webhook':
      return <WebhookFields webhookData={webhookData} workflowId={workflowId} form={form} />;
    case 'manual':
      return <TriggerHint text={tec.triggerPanel.manualHint} />;
    case 'api':
      return <TriggerHint text={tcd.api.hint} />;
    default:
      return null;
  }
}

function TriggerPanel({
  module,
  hasTrigger,
  warning,
  filteredTriggerTypes,
  initialTriggerData,
  onClose,
  ...detailProps
}: TriggerPanelProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const { form, applyTriggerData } = detailProps;

  const handleSelectType = (typeId: string) => {
    form.setTriggerType(typeId);
    // Update workflow immediately
    applyTriggerData(initialTriggerData(typeId));
  };

  return (
    <>
      <div className="p-3 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md bg-purple-100 dark:bg-purple-900/30">
              <Zap className="h-4 w-4 text-purple-600" />
            </div>
            <h3 className="font-semibold text-sm">{hasTrigger ? tec.triggerPanel.editTrigger : tec.triggerPanel.addTrigger}</h3>
          </div>
          <PanelCloseButton onClick={onClose} />
        </div>
      </div>
      {warning && (
        <div className="mx-3 mt-3 p-2.5 rounded-lg bg-amber-50 dark:bg-muted border border-amber-200 dark:border-border">
          <div className="flex items-center gap-2 text-amber-700 dark:text-muted-foreground">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="text-xs">{tec.triggerWarnings[warning]}</span>
          </div>
        </div>
      )}
      <ScrollArea className="flex-1">
        {module === 'helpdesk' ? (
          <HelpdeskTriggerList form={form} applyTriggerData={applyTriggerData} />
        ) : (
          <div className="p-4 space-y-4">
            <TriggerTypeList
              types={filteredTriggerTypes}
              selectedType={form.triggerType}
              onSelect={handleSelectType}
            />
            <TriggerTypeDetails {...detailProps} />
          </div>
        )}
      </ScrollArea>
    </>
  );
}

// ---------------------------------------------------------------------------
// Add action panel
// ---------------------------------------------------------------------------

const ACTION_CATEGORY_ORDER = ['communication', 'data', 'logic', 'integration', 'ai', 'helpdesk'] as const;

interface ActionCategoryGroupProps {
  label: string;
  actions: SidebarActionType[];
  onSelect: (actionId: string) => void;
}

function ActionCategoryGroup({ label, actions, onSelect }: ActionCategoryGroupProps) {
  if (actions.length === 0) return null;
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium">
        {label}
      </Label>
      <div>
        {actions.map((action) => {
          const Icon = getActionMeta(action.id).icon;
          return (
            <Button
              key={action.id}
              type="button"
              variant="ghost"
              onClick={() => onSelect(action.id)}
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
}

interface AddActionPanelProps {
  module: EditorModule;
  actions: SidebarActionType[];
  categoryLabels: Record<string, string>;
  onSelectAction: (actionId: string) => void;
  onClose: () => void;
}

function AddActionPanel({ module, actions, categoryLabels, onSelectAction, onClose }: AddActionPanelProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;

  return (
    <>
      <div className="pl-4 pt-3 pb-3 pr-3 border-b">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-base">{module === 'helpdesk' ? tec.addActionPanel.addAction : tec.addActionPanel.addStep}</h3>
          <PanelCloseButton onClick={onClose} />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3">
          {ACTION_CATEGORY_ORDER.map((category) => (
            <ActionCategoryGroup
              key={category}
              label={categoryLabels[category]}
              actions={actions.filter((a) => a.category === category)}
              onSelect={onSelectAction}
            />
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

// ---------------------------------------------------------------------------
// Branch edit panel
// ---------------------------------------------------------------------------

interface EditingBranch {
  branchNodeId: string;
  branchType: string;
  parentConditionId: string;
  parentConditionStepIndex: number;
}

interface BranchStyle {
  bg: string;
  icon: LucideIcon;
  iconColor: string;
  label: string;
  borderColor: string;
  description: string;
}

/**
 * Marks an add-step request as "after this condition/loop, at its level"
 * (`<stepId>` + suffix) rather than "under this node".
 */
const ADD_STEP_AFTER_SUFFIX = '::after';

// Branch display styling
const BRANCH_STYLE_MAP: Record<string, BranchStyle> = {
  each: { bg: 'bg-blue-100 dark:bg-blue-900/30', icon: Repeat, iconColor: 'text-blue-600', label: 'For each item', borderColor: 'border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900', description: 'Runs once for every item in the list' },
  if: { bg: 'bg-green-100 dark:bg-green-900/30', icon: CheckCircle2, iconColor: 'text-green-600', label: 'If True', borderColor: 'border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900', description: 'Executes when the condition is true' },
  if_not: { bg: 'bg-gray-100 dark:bg-secondary', icon: X, iconColor: 'text-gray-500 dark:text-muted-foreground', label: 'If False', borderColor: 'border-gray-200 bg-gray-50 dark:bg-background/20 dark:border-border', description: 'Executes when the condition is false' },
  escalated: { bg: 'bg-amber-100 dark:bg-amber-900/30', icon: ArrowUpRight, iconColor: 'text-amber-600', label: 'Escalated', borderColor: 'border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900', description: 'Executes when the agent escalates to a human' },
  completed: { bg: 'bg-green-100 dark:bg-green-900/30', icon: CheckCircle2, iconColor: 'text-green-600', label: 'Completed', borderColor: 'border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900', description: 'Executes when the agent resolves the issue' },
  failed: { bg: 'bg-red-100 dark:bg-red-900/30', icon: XCircle, iconColor: 'text-red-600', label: 'Failed', borderColor: 'border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900', description: 'Executes when the agent encounters an error' },
};

function getBranchStyle(branchType: string): BranchStyle {
  return BRANCH_STYLE_MAP[branchType] || {
    bg: 'bg-gray-100 dark:bg-secondary',
    icon: GitBranch,
    iconColor: 'text-gray-500',
    label: branchType,
    borderColor: 'border-gray-200 bg-gray-50 dark:bg-background/20 dark:border-border',
    description: `Executes for "${branchType}" outcome`,
  };
}

function BranchAddStepButton({ className, onClick }: { className?: string; onClick: () => void }) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;

  return (
    <Button variant="outline" size="sm" className={className} onClick={onClick}>
      <Plus className="h-4 w-4 mr-0.5" />
      {tec.addActionPanel.addStep}
    </Button>
  );
}

interface BranchChildStepsProps {
  childSteps: WorkflowStepBag[];
  allSteps: WorkflowStepBag[];
  onSelectStep: (index: number) => void;
  onAddStep: () => void;
}

function BranchChildSteps({ childSteps, allSteps, onSelectStep, onAddStep }: BranchChildStepsProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;

  if (childSteps.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-sm text-muted-foreground mb-3">{tec.addActionPanel.noStepsInBranch}</p>
        <BranchAddStepButton onClick={onAddStep} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {childSteps.map((childStep) => {
        const meta = getActionMeta(childStep.type || '');
        const Icon = meta.icon;
        const stepIndex = allSteps.findIndex((s) => s.id === childStep.id);
        const summary = getConfigSummary(childStep.type || '', childStep.config || {});
        return (
          <Button
            key={childStep.id}
            variant="ghost"
            onClick={() => onSelectStep(stepIndex)}
            className="w-full text-left p-3 rounded-lg border border-border hover:border-blue-200 transition-colors"
          >
            <div className="flex items-center gap-2">
              <div className={cn('w-6 h-6 rounded-md flex items-center justify-center', meta.bgColor)}>
                <Icon className={cn('w-3.5 h-3.5', meta.color)} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{childStep.name}</p>
                {summary && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {summary}
                  </p>
                )}
              </div>
            </div>
          </Button>
        );
      })}
      <BranchAddStepButton className="w-full mt-2" onClick={onAddStep} />
    </div>
  );
}

interface BranchEditPanelProps {
  branch: EditingBranch;
  steps: WorkflowStepBag[];
  onSelectStep: (index: number) => void;
  onAddStep: () => void;
  onClose: () => void;
}

function BranchEditPanel({ branch, steps, onSelectStep, onAddStep, onClose }: BranchEditPanelProps) {
  const { t } = useI18n();
  const tbp = t.weldconnect.workflowEditorClient.branchPanel;
  const parentStep = steps[branch.parentConditionStepIndex];
  const isLoop = parentStep?.type === 'loop';
  const branchChildren = steps.filter((s) => s.parentBranchId === branch.branchNodeId);
  let conditionExpression: string;
  if (isLoop) {
    conditionExpression = typeof parentStep?.config?.items === 'string' ? parentStep.config.items : '';
  } else if (parentStep?.config?.field) {
    conditionExpression = `${parentStep.config.field} ${parentStep.config.operator || ''} ${parentStep.config.value || ''}`;
  } else {
    conditionExpression = (parentStep?.config?.expression as string | undefined) || '';
  }
  const translatedBranch: Record<string, { label: string; description: string }> = {
    if: tbp.ifTrue,
    if_not: tbp.ifFalse,
    each: tbp.forEachItem,
  };
  const baseStyle = getBranchStyle(branch.branchType);
  const branchStyle = { ...baseStyle, ...translatedBranch[branch.branchType] };
  const BranchIcon = branchStyle.icon;
  const ParentIcon = isLoop ? Repeat : GitBranch;

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
          <PanelCloseButton onClick={onClose} />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Condition Info */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {isLoop ? tbp.parentLoop : tbp.parentCondition}
            </Label>
            <Button
              variant="ghost"
              onClick={() => onSelectStep(branch.parentConditionStepIndex)}
              className="w-full text-left p-3 rounded-lg border border-border hover:border-amber-200 transition-colors"
            >
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                  <ParentIcon className="w-3.5 h-3.5 text-amber-600" />
                </div>
                <span className="text-sm font-medium">{parentStep?.name || (isLoop ? tbp.parentLoop : tbp.parentCondition)}</span>
              </div>
              {conditionExpression && (
                <p className="text-xs text-muted-foreground mt-2 truncate">{conditionExpression}</p>
              )}
            </Button>
          </div>

          {/* Branch Description */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{tbp.branch}</Label>
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

            <BranchChildSteps
              childSteps={branchChildren}
              allSteps={steps}
              onSelectStep={onSelectStep}
              onAddStep={onAddStep}
            />
          </div>
        </div>
      </ScrollArea>
    </>
  );
}

// ---------------------------------------------------------------------------
// Edit step panel
// ---------------------------------------------------------------------------

/** "{field}: "{value}" is not a valid email address" for each badly formatted literal value. */
function useFormatIssueMessages(step: WorkflowStepBag): string[] {
  const { t } = useI18n();
  const tes = t.weldconnect.workflowEditorClient.editStepPanel;
  const acf = t.weldconnect.actionConfigForm as Record<string, unknown>;
  return getStepFormatIssues(step).map((issue) =>
    (issue.kind === 'email' ? tes.invalidEmail : tes.invalidUrl)
      .replace('{field}', (acf[issue.labelKey] as string | undefined) || issue.labelKey)
      .replace('{value}', issue.value),
  );
}

/** Non-blocking note: these `{{variables}}` resolve to nothing, so they render empty. */
function UnknownVariablesNote({ variables }: { variables: string[] }) {
  const { t } = useI18n();
  if (variables.length === 0) return null;
  return (
    <div className="mx-3 mt-2 p-2.5 rounded-lg bg-amber-50 dark:bg-muted border border-amber-200 dark:border-border">
      <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div className="min-w-0 text-xs">
          <p>{t.weldconnect.workflowEditorClient.editStepPanel.unknownVariablesHint}</p>
          <p className="mt-1 font-mono break-all">{variables.map((path) => `{{${path}}}`).join(', ')}</p>
        </div>
      </div>
    </div>
  );
}

function StepStatusBanner({ step, unsupported }: { step: WorkflowStepBag; unsupported: boolean }) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const acf = t.weldconnect.actionConfigForm as Record<string, unknown>;
  const formatIssues = useFormatIssueMessages(step);

  if (unsupported) {
    return (
      <div className="mx-3 mt-3 p-2.5 rounded-lg bg-amber-50 dark:bg-muted border border-amber-200 dark:border-border">
        <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span className="text-xs">{tec.publishGate.unsupportedStep}</span>
        </div>
      </div>
    );
  }
  const missing = getMissingRequiredFields(step.type || '', step.config || {});
  if (missing.length === 0 && formatIssues.length > 0) {
    return (
      <div className="mx-3 mt-3 p-3 rounded-lg bg-amber-50 dark:bg-muted border border-amber-200 dark:border-border">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="text-xs font-medium">{tec.editStepPanel.invalidValuesTitle}</span>
        </div>
        <ul className="mt-1 space-y-0.5 text-xs text-amber-700/80 dark:text-muted-foreground">
          {formatIssues.map((message) => <li key={message} className="break-words">{message}</li>)}
        </ul>
      </div>
    );
  }
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
            {(acf[m.labelKey] as string | undefined) || m.labelKey}
          </span>
        ))}
      </div>
      {formatIssues.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-700/80 dark:text-muted-foreground">
          {formatIssues.map((message) => <li key={message} className="break-words">{message}</li>)}
        </ul>
      )}
    </div>
  );
}

interface EditStepPanelProps {
  step: WorkflowStepBag;
  steps: WorkflowStepBag[];
  triggerType: string | undefined;
  unsupported: boolean;
  /** `{{paths}}` in this step that resolve to nothing (see `flagUnknownVariables`). */
  unknownVariables: string[];
  emailAccounts: NonNullable<WorkflowEditorClientProps['emailAccounts']>;
  workspaceMembers: NonNullable<WorkflowEditorClientProps['workspaceMembers']>;
  workflowVariables: Array<{ name: string; type?: string }>;
  extraVariableGroups: WorkflowEditorClientProps['extraVariableGroups'];
  excludeVariableGroups: string[] | undefined;
  onStepChange: (step: WorkflowStepBag) => void;
  onUpdateStep: (stepId: string, data: Record<string, unknown>) => void;
  onDelete: () => void;
  /** Set for conditions and loops: add a step at the same level, after the step and its branches. */
  onAddStepAfter?: () => void;
  onClose: () => void;
}

function EditStepPanel({
  step,
  steps,
  triggerType,
  unsupported,
  unknownVariables,
  emailAccounts,
  workspaceMembers,
  workflowVariables,
  extraVariableGroups,
  excludeVariableGroups,
  onStepChange,
  onUpdateStep,
  onDelete,
  onAddStepAfter,
  onClose,
}: EditStepPanelProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const meta = getActionMeta(step.type || '');
  const Icon = meta.icon;
  const nameFieldId = useId();
  const descriptionFieldId = useId();

  return (
    <>
      <div className="p-3 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn('p-1.5 rounded-md', meta.bgColor)}>
              <Icon className={cn('h-4 w-4', meta.color)} />
            </div>
            <h3 className="font-semibold text-sm">{tec.editStepPanel.editStep}</h3>
          </div>
          <PanelCloseButton onClick={onClose} />
        </div>
      </div>
      <StepStatusBanner step={step} unsupported={unsupported} />
      {!unsupported && <UnknownVariablesNote variables={unknownVariables} />}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor={nameFieldId} className="text-xs font-medium">{tec.editStepPanel.actionNameLabel}</Label>
            <Input
              id={nameFieldId}
              value={step.name || ''}
              onChange={(e) => {
                const newName = e.target.value;
                onStepChange({ ...step, name: newName });
                onUpdateStep(step.id || '', { name: newName });
              }}
              placeholder={tec.editStepPanel.actionNamePlaceholder}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={descriptionFieldId} className="text-xs font-medium">{tec.editStepPanel.descriptionLabel}</Label>
            <Textarea
              id={descriptionFieldId}
              value={step.description || ''}
              onChange={(e) => {
                const newDescription = e.target.value;
                onStepChange({ ...step, description: newDescription });
                onUpdateStep(step.id || '', { description: newDescription });
              }}
              placeholder={tec.editStepPanel.descriptionPlaceholder}
              rows={3}
            />
          </div>

          <div className="border-t pt-4">
            <h4 className="text-xs font-medium mb-3 text-muted-foreground uppercase tracking-wide">{tec.editStepPanel.settingsLabel}</h4>
            <ActionConfigForm
              actionType={step.type || ''}
              config={step.config || {}}
              onChange={(config) => {
                onStepChange({ ...step, config });
                onUpdateStep(step.id || '', { config });
              }}
              emailAccounts={emailAccounts}
              workspaceMembers={workspaceMembers}
              workflowSteps={steps.map((s) => ({
                id: s.id || '',
                name: s.name || '',
                type: s.type || '',
              }))}
              currentStepIndex={steps.findIndex((s) => s.id === step.id)}
              workflowVariables={workflowVariables}
              triggerType={triggerType}
              extraVariableGroups={extraVariableGroups}
              excludeGroups={excludeVariableGroups}
            />
          </div>
        </div>
      </ScrollArea>
      <div className="p-3 space-y-2">
        {onAddStepAfter && (
          <Button variant="outline" className="w-full" onClick={onAddStepAfter}>
            <Plus className="h-4 w-4 mr-0.5" />
            {step.type === 'loop' ? tec.editStepPanel.addStepAfterLoop : tec.editStepPanel.addStepAfterCondition}
          </Button>
        )}
        <Button
          variant="outline"
          className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
          {tec.editStepPanel.deleteStep}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Overview panel
// ---------------------------------------------------------------------------

function ChecklistCard({
  icon,
  title,
  badge,
  alignTop,
  message,
  onClick,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  badge: React.ReactNode;
  alignTop?: boolean;
  message: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="w-full text-left p-3 rounded-lg border border-border hover:border-blue-200 transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-blue-100 flex items-center justify-center">
            {icon}
          </div>
          <span className="text-sm font-medium">{title}</span>
        </div>
        <span className="px-2 py-0.5 text-xs font-medium text-muted-foreground bg-muted border border-border rounded-md">
          {badge}
        </span>
      </div>
      <div className="my-3 border-t border-border" />
      <div className={cn('flex gap-1.5 text-amber-600', alignTop ? 'items-start' : 'items-center')}>
        <AlertCircle className={cn('w-3.5 h-3.5', alignTop && 'mt-0.5 flex-shrink-0')} />
        <span className="text-xs">{message}</span>
      </div>
    </Button>
  );
}

interface StepChecklistItemProps {
  step: WorkflowStepBag;
  index: number;
  unsupported: boolean;
  unknownVariables: string[];
  actionTypes: SidebarActionType[];
  categoryLabels: Record<string, string>;
  onSelectStep: (index: number) => void;
}

function StepChecklistItem({ step, index, unsupported, unknownVariables, actionTypes, categoryLabels, onSelectStep }: StepChecklistItemProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const missing = getMissingRequiredFields(step.type || '', step.config || {});
  const formatIssues = useFormatIssueMessages(step);
  if (!unsupported && missing.length === 0 && formatIssues.length === 0 && unknownVariables.length === 0) return null;

  const acf = t.weldconnect.actionConfigForm as Record<string, unknown>;
  const missingLabels = missing.map((m) => acf[m.labelKey] || m.labelKey).join(', ');
  const actionMeta = actionTypes.find((a) => a.id === step.type);
  const Icon = step.type ? getActionMeta(step.type).icon : Code;
  const messages = [
    ...(missing.length > 0 ? [tec.overviewPanel.missingFields.replace('{fields}', missingLabels)] : []),
    ...formatIssues,
    ...(unknownVariables.length > 0
      ? [tec.overviewPanel.unknownVariables.replace('{variables}', unknownVariables.map((path) => `{{${path}}}`).join(', '))]
      : []),
  ];

  return (
    <ChecklistCard
      icon={<Icon className="w-3.5 h-3.5 text-blue-600" />}
      title={step.name}
      badge={categoryLabels[actionMeta?.category || 'data']}
      alignTop
      message={unsupported ? tec.publishGate.unsupportedStep : messages.join(' · ')}
      onClick={() => onSelectStep(index)}
    />
  );
}

interface OverviewPanelProps {
  steps: WorkflowStepBag[];
  triggerLocked?: boolean;
  triggerIssue: string | null;
  triggerTypeId: string | undefined;
  triggerTypes: Array<{ id: string; name: string }>;
  allStepsConfigured: boolean;
  actionTypes: SidebarActionType[];
  categoryLabels: Record<string, string>;
  hideTemplatesAndAi?: boolean;
  isStepUnsupported: (type: string | undefined) => boolean;
  getUnknownVariables: (step: WorkflowStepBag) => string[];
  onSelectTrigger: () => void;
  onSelectStep: (index: number) => void;
  onOpenTemplates: () => void;
  onCloseMobile: () => void;
}

function OverviewPanel({
  steps,
  triggerLocked,
  triggerIssue,
  triggerTypeId,
  triggerTypes,
  allStepsConfigured,
  actionTypes,
  categoryLabels,
  hideTemplatesAndAi,
  isStepUnsupported,
  getUnknownVariables,
  onSelectTrigger,
  onSelectStep,
  onOpenTemplates,
  onCloseMobile,
}: OverviewPanelProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const showTriggerCheck = !triggerLocked && !!triggerIssue;
  const showAllConfigured = (triggerLocked || !triggerIssue) && steps.length > 0 && allStepsConfigured;

  return (
    <>
      {/* Mobile header for overview panel */}
      <div className="p-3 border-b lg:hidden flex items-center justify-between">
        <h3 className="font-semibold text-sm">{tec.overviewPanel.workflowDetails}</h3>
        <PanelCloseButton onClick={onCloseMobile} />
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
            {showTriggerCheck && (
              <ChecklistCard
                icon={<Zap className="w-3.5 h-3.5 text-blue-600" />}
                title={triggerTypeId
                  ? triggerTypes.find((tr) => tr.id === triggerTypeId)?.name
                  : tec.overviewPanel.selectTrigger}
                badge={tec.overviewPanel.triggerBadge}
                message={tec.overviewPanel.triggerNeedsConfig}
                onClick={onSelectTrigger}
              />
            )}

            {/* Steps that need configuration */}
            {steps.map((step, index) => (
              <StepChecklistItem
                key={step.id}
                step={step}
                index={index}
                unsupported={isStepUnsupported(step.type)}
                unknownVariables={getUnknownVariables(step)}
                actionTypes={actionTypes}
                categoryLabels={categoryLabels}
                onSelectStep={onSelectStep}
              />
            ))}

            {/* All configured message */}
            {showAllConfigured && (
              <div className="flex items-center gap-2 px-3 py-[11px] rounded-lg border border-border text-muted-foreground">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <span className="text-sm">{tec.overviewPanel.allStepsConfigured}</span>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Helpful Resources - Fixed at bottom */}
      <div className={cn('p-4 border-t', hideTemplatesAndAi && 'hidden')}>
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
            onClick={onOpenTemplates}
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
  );
}

// ---------------------------------------------------------------------------
// Sub-agent dialogs
// ---------------------------------------------------------------------------

interface SubAgentForm {
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
}

interface SavedAgent {
  id: string;
  name: string;
  description?: string;
  moduleKey: string;
}

interface McpConnection {
  id: string;
  name: string;
  provider: string;
  status: string;
  settings: {
    discoveredTools?: Array<{ name: string; description: string }>;
    [key: string]: unknown;
  };
}

type SetSubAgentForm = React.Dispatch<React.SetStateAction<SubAgentForm | null>>;

const BUILTIN_SUB_AGENT_TOOLS = [
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
];

function toggleBuiltinTool(form: SubAgentForm, toolName: string): SubAgentForm {
  const tools = form.enabledBuiltinTools.includes(toolName)
    ? form.enabledBuiltinTools.filter((name) => name !== toolName)
    : [...form.enabledBuiltinTools, toolName];
  return { ...form, enabledBuiltinTools: tools };
}

function toggleIntegration(
  form: SubAgentForm,
  connectionId: string,
  allToolNames: string[],
  enabled: boolean,
): SubAgentForm {
  if (enabled) {
    return {
      ...form,
      integrationIds: [...form.integrationIds, connectionId],
      integrationToolPermissions: { ...form.integrationToolPermissions, [connectionId]: allToolNames },
    };
  }
  const { [connectionId]: _, ...restPerms } = form.integrationToolPermissions;
  return {
    ...form,
    integrationIds: form.integrationIds.filter((id) => id !== connectionId),
    integrationToolPermissions: restPerms,
  };
}

function toggleIntegrationTool(
  form: SubAgentForm,
  connectionId: string,
  toolName: string,
  allowed: boolean,
): SubAgentForm {
  const current = form.integrationToolPermissions[connectionId] || [];
  const next = allowed
    ? [...current, toolName]
    : current.filter((name) => name !== toolName);
  return {
    ...form,
    integrationToolPermissions: { ...form.integrationToolPermissions, [connectionId]: next },
  };
}

interface SubAgentPickerDialogProps {
  stepId: string | null;
  steps: WorkflowStepBag[];
  savedAgents: SavedAgent[] | undefined;
  onSelect: (agentId: string, agentName: string) => void;
  onClose: () => void;
}

function SubAgentPickerList({
  step,
  savedAgents,
  onSelect,
}: {
  step: WorkflowStepBag | null | undefined;
  savedAgents: SavedAgent[] | undefined;
  onSelect: (agentId: string, agentName: string) => void;
}) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const stepConfig = step?.config as Record<string, unknown> | undefined;
  const currentSubIds: string[] = (stepConfig?.subAgentIds as string[] | undefined) || [];
  const headAgentId = stepConfig?.agentDefinitionId;
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
  return (
    <>
      {available.map((agent) => (
        <Button
          key={agent.id}
          type="button"
          variant="ghost"
          onClick={() => onSelect(agent.id, agent.name)}
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
      ))}
    </>
  );
}

function SubAgentPickerDialog({ stepId, steps, savedAgents, onSelect, onClose }: SubAgentPickerDialogProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const step = stepId ? steps.find((s) => s.id === stepId) : null;

  return (
    <Dialog open={!!stepId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tec.subAgentDialog.addSubAgent}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 max-h-[400px] overflow-y-auto">
          <SubAgentPickerList step={step} savedAgents={savedAgents} onSelect={onSelect} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

const SUB_AGENT_LABEL_CLASS = 'text-xs font-medium text-muted-foreground';

function SubAgentLeftColumn({ form, setForm }: { form: SubAgentForm; setForm: SetSubAgentForm }) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const patch = (partial: Partial<SubAgentForm>) => setForm({ ...form, ...partial });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.nameLabel} *</label>
          <Input
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder={tec.subAgentDialog.agentNamePlaceholder}
            className="mt-1"
          />
        </div>
        <div>
          <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.descriptionLabel}</label>
          <Input
            value={form.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder={tec.subAgentDialog.agentDescriptionPlaceholder}
            className="mt-1"
          />
        </div>
      </div>

      <div>
        <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.systemPromptLabel} *</label>
        <Textarea
          value={form.systemPrompt}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
          placeholder={tec.subAgentDialog.systemPromptPlaceholder}
          rows={6}
          className="mt-1"
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.modelLabel}</label>
          <Select
            value={form.modelId}
            onValueChange={(v) => patch({ modelId: v })}
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
          <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.temperatureLabel}</label>
          <Input
            type="number"
            value={form.temperature}
            onChange={(e) => patch({ temperature: Number.parseFloat(e.target.value) || 0.7 })}
            min={0}
            max={2}
            step={0.1}
            className="mt-1"
          />
        </div>
        <div>
          <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.maxIterationsLabel}</label>
          <Input
            type="number"
            value={form.maxIterations}
            onChange={(e) => patch({ maxIterations: Number.parseInt(e.target.value) || 10 })}
            min={1}
            max={50}
            className="mt-1"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.maxTokensLabel}</label>
          <Input
            type="number"
            value={form.maxTokens}
            onChange={(e) => patch({ maxTokens: Number.parseInt(e.target.value) || 1024 })}
            min={100}
            max={16384}
            className="mt-1"
          />
        </div>
        <div>
          <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.tokenBudgetLabel}</label>
          <Input
            type="number"
            value={form.maxTotalTokens}
            onChange={(e) => patch({ maxTotalTokens: Number.parseInt(e.target.value) || 20000 })}
            min={1000}
            max={100000}
            step={1000}
            className="mt-1"
          />
        </div>
      </div>
    </div>
  );
}

function SubAgentIntegrationItem({
  connection,
  form,
  setForm,
}: {
  connection: McpConnection;
  form: SubAgentForm;
  setForm: SetSubAgentForm;
}) {
  const isEnabled = form.integrationIds.includes(connection.id);
  const discoveredTools = connection.settings?.discoveredTools || [];
  const allowedTools = form.integrationToolPermissions[connection.id] || [];
  const hasTools = isEnabled && discoveredTools.length > 0;

  const handleToggleIntegration = (checked: boolean | 'indeterminate') => {
    const allToolNames = discoveredTools.map((tool) => tool.name);
    setForm((prev) => (prev ? toggleIntegration(prev, connection.id, allToolNames, !!checked) : prev));
  };

  const handleToggleTool = (toolName: string, checked: boolean | 'indeterminate') => {
    setForm((prev) => (prev ? toggleIntegrationTool(prev, connection.id, toolName, !!checked) : prev));
  };

  return (
    <div className="rounded-md border p-2.5 space-y-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <Checkbox checked={isEnabled} onCheckedChange={handleToggleIntegration} />
        <span className="text-sm font-medium">{connection.name}</span>
        {hasTools && (
          <span className="text-xs text-muted-foreground ml-auto">{allowedTools.length}/{discoveredTools.length}</span>
        )}
      </label>
      {hasTools && (
        <div className="ml-6 space-y-0.5">
          {discoveredTools.map((tool) => (
            <label key={tool.name} className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={allowedTools.includes(tool.name)}
                onCheckedChange={(checked) => handleToggleTool(tool.name, checked)}
              />
              <span className="text-xs">{tool.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function SubAgentRightColumn({
  form,
  setForm,
  mcpConnections,
}: {
  form: SubAgentForm;
  setForm: SetSubAgentForm;
  mcpConnections: McpConnection[] | undefined;
}) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;
  const connections = mcpConnections || [];
  const patchEscalation = (partial: Partial<SubAgentForm['escalationRules']>) =>
    setForm({ ...form, escalationRules: { ...form.escalationRules, ...partial } });

  return (
    <div className="space-y-4">
      <div>
        <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.toolsLabel}</label>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1.5">
          {BUILTIN_SUB_AGENT_TOOLS.map((tool) => (
            <label key={tool.name} className="flex items-center gap-2 cursor-pointer py-1">
              <Checkbox
                checked={form.enabledBuiltinTools.includes(tool.name)}
                onCheckedChange={() => {
                  setForm((prev) => (prev ? toggleBuiltinTool(prev, tool.name) : prev));
                }}
              />
              <span className="text-sm">{tool.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.escalationLabel}</label>
        <div className="space-y-1 mt-1.5">
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={form.escalationRules.escalateOnFailure}
              onCheckedChange={(checked) => patchEscalation({ escalateOnFailure: !!checked })}
            />
            <span className="text-sm">{tec.subAgentDialog.escalateOnError}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={form.escalationRules.escalateOnMaxIterations}
              onCheckedChange={(checked) => patchEscalation({ escalateOnMaxIterations: !!checked })}
            />
            <span className="text-sm">{tec.subAgentDialog.escalateOnMaxIterations}</span>
          </label>
        </div>
      </div>

      {/* Integrations (MCP Servers) */}
      {connections.length > 0 && (
        <div>
          <label className={SUB_AGENT_LABEL_CLASS}>{tec.subAgentDialog.integrationsLabel}</label>
          <div className="space-y-2 mt-1.5">
            {connections.map((conn) => (
              <SubAgentIntegrationItem key={conn.id} connection={conn} form={form} setForm={setForm} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface SubAgentEditDialogProps {
  open: boolean;
  form: SubAgentForm | null;
  setForm: SetSubAgentForm;
  mcpConnections: McpConnection[] | undefined;
  isSaving: boolean;
  onClose: () => void;
  onSave: () => void;
}

function SubAgentEditDialog({ open, form, setForm, mcpConnections, isSaving, onClose, onSave }: SubAgentEditDialogProps) {
  const { t } = useI18n();
  const tec = t.weldconnect.workflowEditorClient;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tec.subAgentDialog.editSubAgent}</DialogTitle>
        </DialogHeader>
        {form ? (
          <div className="grid grid-cols-2 gap-6">
            <SubAgentLeftColumn form={form} setForm={setForm} />
            <SubAgentRightColumn form={form} setForm={setForm} mcpConnections={mcpConnections} />
          </div>
        ) : (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-violet-500" />
          </div>
        )}
        {form && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {tec.subAgentDialog.cancel}
            </Button>
            <Button onClick={onSave} disabled={isSaving}>
              {isSaving ? tec.subAgentDialog.saving : tec.subAgentDialog.saveChanges}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowEditorClient({
  workflow: initialWorkflow,
  actionTypes,
  triggerTypes,
  entityEvents,
  emailAccounts = [],
  workspaceMembers = [],
  workflowVariables = NO_WORKFLOW_VARIABLES,
  workflowsForChaining = [],
  webhookData,
  basePath = '/weldconnect/workflows',
  parentLabel = 'Task',
  parentHref = '/weldconnect',
  listLabel = 'Workflows',
  allowedActionIds,
  allowedTriggerTypes,
  allowedScheduleTypes,
  blockUnsupported,
  hideTemplatesAndAi,
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
  showStatus,
  resolveRecordFields,
  flagUnknownVariables,
  testerEmail,
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
    void agentInvalidateQc.invalidateQueries({ queryKey: automationKeys.workflow(initialWorkflow.id) });
    void agentInvalidateQc.invalidateQueries({ queryKey: automationKeys.workflows() });
    void agentInvalidateQc.invalidateQueries({ queryKey: workflowEditorKeys.workflow(initialWorkflow.id) });
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
    if (allowedTriggerTypes) {
      return TRIGGER_TYPES.filter((t) => allowedTriggerTypes.includes(t.id));
    }
    return TRIGGER_TYPES;
  }, [module, TRIGGER_TYPES, allowedTriggerTypes]);

  const oneTimeScheduleAllowed = !allowedScheduleTypes || allowedScheduleTypes.includes('one_time');
  const isStepUnsupported = useCallback(
    (type: string | undefined) => !!blockUnsupported && !!allowedActionIds && !allowedActionIds.includes(type || ''),
    [blockUnsupported, allowedActionIds],
  );
  const isTriggerUnsupported = useCallback(
    (trigger: WorkflowTriggerBag | undefined) => {
      if (!blockUnsupported || !trigger?.type) return false;
      if (allowedTriggerTypes && !allowedTriggerTypes.includes(trigger.type)) return true;
      const scheduleType = trigger.scheduleType ?? (trigger.config as { scheduleType?: string } | undefined)?.scheduleType;
      return trigger.type === 'schedule' && scheduleType === 'one_time' && !oneTimeScheduleAllowed;
    },
    [blockUnsupported, allowedTriggerTypes, oneTimeScheduleAllowed],
  );

  const integrationTriggers = useMemo(
    () => (triggerTypes ?? []).filter((t) => t.category === 'integration'),
    [triggerTypes],
  );

  // Filter entity events based on module
  const filteredEntityEvents = useMemo(() => {
    if (module === 'helpdesk') {
      // Only show helpdesk entity types
      return entityEvents.filter((e) => e.category === 'Helpdesk');
    }
    return entityEvents;
  }, [module, entityEvents]);

  // Group entity types by category for the picker — the catalog now exposes
  // ~150 entity types, so a flat list would be unusable. Preserves the order
  // entities arrive in within each category.
  const groupedEntityEvents = useMemo(() => {
    const groups: Array<{ category: string; entities: EntityEvent[] }> = [];
    const byCategory = new Map<string, EntityEvent[]>();
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
    () => extraVariableGroups ? buildAllVariables({
      triggerType: initialWorkflow.triggers?.[0]?.type,
      workflowVariables,
      extraVariableGroups,
      excludeGroups: excludeVariableGroups,
      labels: t.weldconnect.variablePicker,
    }) : undefined,
    [initialWorkflow.triggers, workflowVariables, extraVariableGroups, excludeVariableGroups, t.weldconnect.variablePicker],
  );

  const router = useRouter();
  const searchParams = useSearchParams();
  const initialPanel = searchParams.get('panel');

  // Ensure triggers and steps are always arrays (handle null from database)
  const defaultTriggers = triggerLocked
    ? [{ id: 'trigger-enrollment', type: 'manual', name: 'Person Enrolled' }]
    : (initialWorkflow.triggers || []);
  const [workflow, setWorkflow] = useState<EditorWorkflow & { triggers: WorkflowTriggerBag[]; steps: WorkflowStepBag[] }>({
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
  const [editingStep, setEditingStep] = useState<WorkflowStepBag | null>(null);
  const [_selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);

  // --- Validation: which steps / the trigger still need required config -----
  const stepNeedsWork = useCallback(
    (s: WorkflowStepBag) =>
      isStepUnsupported(s.type) || !isStepConfigured(asWorkflowStep(s)) || getStepFormatIssues(s).length > 0,
    [isStepUnsupported],
  );
  const incompleteStepIds = useMemo(
    () => new Set(workflow.steps.filter(stepNeedsWork).map((s) => s.id)),
    [workflow.steps, stepNeedsWork],
  );
  const firstIncompleteStepIndex = useMemo(
    () => workflow.steps.findIndex(stepNeedsWork),
    [workflow.steps, stepNeedsWork],
  );
  const triggerWarning = triggerLocked
    ? null
    : getTriggerWarning(workflow.triggers?.[0], workflow.triggers?.[0]?.type || '');
  const triggerIssue = useMemo(() => {
    if (triggerLocked) return null;
    if (isTriggerUnsupported(workflow.triggers?.[0])) return tec.publishGate.unsupportedTrigger;
    return triggerWarning;
  }, [workflow.triggers, triggerLocked, isTriggerUnsupported, tec.publishGate.unsupportedTrigger, triggerWarning]);

  // The record an entity-event trigger delivers: picker entries, the
  // unknown-variable check and the Test dialog's sample all come from it.
  const firstTrigger = workflow.triggers?.[0];
  const isEntityEventTrigger = firstTrigger?.type === 'entity_event';
  const savedEntityType = isEntityEventTrigger ? (firstTrigger?.entityType as string | undefined) : undefined;
  const savedEventType = isEntityEventTrigger ? (firstTrigger?.eventType as string | undefined) : undefined;
  const recordFieldDefs = useMemo(
    () => (isEntityEventTrigger ? resolveRecordFields?.(savedEntityType, savedEventType) : undefined),
    [isEntityEventTrigger, resolveRecordFields, savedEntityType, savedEventType],
  );
  const recordFieldLabels = t.weldconnect.recordFields as Record<string, string>;
  const triggerRecordFields = useMemo(() => {
    if (!isEntityEventTrigger || !resolveRecordFields) return undefined;
    // An entity whose payload is not catalogued: only its id is certain.
    const defs: RecordFieldDef[] = recordFieldDefs ?? [{ path: 'id' }];
    return defs.map((field) => ({
      path: field.path,
      label: recordFieldLabels[field.path] ?? field.path,
      type: field.type ?? ('string' as const),
    }));
  }, [isEntityEventTrigger, resolveRecordFields, recordFieldDefs, recordFieldLabels]);
  const testRecordFields = useMemo(
    () => recordFieldDefs?.map((field) => ({
      path: field.path,
      label: recordFieldLabels[field.path] ?? field.path,
      sample: field.sample,
    })),
    [recordFieldDefs, recordFieldLabels],
  );

  const getUnknownVariables = useCallback(
    (step: WorkflowStepBag): string[] => {
      if (!flagUnknownVariables) return [];
      const index = workflow.steps.findIndex((s) => s.id === step.id);
      return findUnknownVariables(step.config, {
        triggerType: triggerLocked ? 'manual' : firstTrigger?.type,
        recordFields: recordFieldDefs?.map((field) => field.path),
        previousStepIds: workflow.steps.slice(0, Math.max(index, 0)).map((s) => s.id || ''),
        variableNames: workflowVariables.map((variable) => variable.name),
        extraRoots: extraVariableGroups?.flatMap((group) => group.variables.map((v) => v.path.split('.')[0])),
        inLoop: isInsideLoop(step, workflow.steps),
      });
    },
    [flagUnknownVariables, workflow.steps, triggerLocked, firstTrigger?.type, recordFieldDefs, workflowVariables, extraVariableGroups],
  );

  // Draft / Active / Paused, when the host shows it (see `showStatus`).
  const status = showStatus && !onPublish ? String(workflow.status ?? 'draft').toLowerCase() : undefined;
  const [showTestDialog, setShowTestDialog] = useState(false);
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
  const [triggerEntityType, setTriggerEntityType] = useState((workflow.triggers?.[0]?.entityType as string | undefined) || '');
  const [triggerEventType, setTriggerEventType] = useState((workflow.triggers?.[0]?.eventType as string | undefined) || '');
  const [integrationTriggerEventId, setIntegrationTriggerEventId] = useState(
    () => (workflow.triggers?.[0]?.event as string | undefined) || '',
  );
  const [scheduleType, setScheduleType] = useState<'one_time' | 'recurring'>('recurring');
  const [scheduleCronPreset, setScheduleCronPreset] = useState('every_day_9am');
  const [scheduleCustomCron, setScheduleCustomCron] = useState('0 9 * * *');
  const [scheduleTimezone, setScheduleTimezone] = useState('Europe/Amsterdam');
  const [scheduleExecuteAt, setScheduleExecuteAt] = useState('');

  // The trigger written when a type is picked. A schedule starts from the
  // panel's current (default: daily 09:00, recurring) settings so it is
  // runnable as-is instead of "missing schedule type" until a control is touched.
  const initialTriggerData = (type: string): WorkflowTriggerBag => {
    if (type !== 'schedule') return { type, isEnabled: true };
    const mode = scheduleType === 'one_time' && oneTimeScheduleAllowed ? 'one_time' : 'recurring';
    const cronExpression = resolveCronExpression(scheduleCronPreset, scheduleCustomCron, CRON_PRESETS);
    return {
      type: 'schedule',
      isEnabled: true,
      scheduleType: mode,
      ...(mode === 'one_time' ? { executeAt: scheduleExecuteAt } : { cronExpression }),
      timezone: scheduleTimezone,
    };
  };

  // Integration / workflow-complete trigger state
  const [sourceWorkflowId, setSourceWorkflowId] = useState('');
  const [workflowCompleteTriggerOn, setWorkflowCompleteTriggerOn] = useState<'success' | 'failure' | 'both'>('success');
  const [workflowCompletePassOutput, setWorkflowCompletePassOutput] = useState(false);

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
    queryFn: async (): Promise<{
      name?: string;
      description?: string;
      systemPrompt?: string;
      modelId?: string;
      temperature?: string | number;
      maxTokens?: number;
      maxIterations?: number;
      maxTotalTokens?: number;
      enabledBuiltinTools?: string[];
      integrationIds?: string[];
      integrationToolPermissions?: Record<string, string[]>;
      escalationRules?: { escalateOnFailure?: boolean; escalateOnMaxIterations?: boolean };
    } | undefined> => undefined,
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
      return (res.data || []).filter((c) => c.provider === 'mcp_server' && c.status === 'active');
    },
  });

  const [subAgentForm, setSubAgentForm] = useState<SubAgentForm | null>(null);

  // Populate form when agent data loads
  useEffect(() => {
    if (editSubAgentData && editSubAgentId) {
      setSubAgentForm({
        name: editSubAgentData.name || '',
        description: editSubAgentData.description || '',
        systemPrompt: editSubAgentData.systemPrompt || '',
        modelId: editSubAgentData.modelId || 'openai/gpt-4o',
        temperature: Number.parseFloat(String(editSubAgentData.temperature ?? '')) || 0.7,
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
    mutationFn: async (_params: { id: string; data: unknown }): Promise<never> => {
      throw new Error('AI is currently unavailable');
    },
    onError: () => toast.error(tec.toasts.agentUpdateFailed),
  });

  // Branch editing state
  const [editingBranch, setEditingBranch] = useState<EditingBranch | null>(null);

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

  const handleSave = async (savedMessage: string = tec.toasts.workflowSaved) => {
    // A malformed cron expression is stored as typed and then never fires.
    if (triggerWarning === 'invalidCron') {
      handleSelectTrigger();
      setShowMobileSidebar(true);
      toast.error(tec.triggerWarnings.invalidCron);
      return false;
    }
    try {
      await updateWorkflowMutation.mutateAsync({
        id: workflow.id,
        data: {
          name: workflow.name,
          description: workflow.description ?? undefined,
          triggers: workflow.triggers,
          steps: workflow.steps,
        },
      });
      savedSnapshotRef.current = JSON.stringify({ triggers: workflow.triggers, steps: workflow.steps });
      toast.success(savedMessage);
      return true;
    } catch (err) {
      toast.error(isUnsupportedWorkflowError(err) ? tec.toasts.publishUnsupported : tec.toasts.saveFailed);
      return false;
    }
  };

  // A test is a real run, so it goes through a dialog that says so and collects
  // the sample record (see TestRunDialog) instead of firing on click.
  const handleRunTest = (request: TestRunRequest) => {
    testWorkflowMutation.mutate({ id: workflow.id, ...request }, {
      onSuccess: (result) => {
        setShowTestDialog(false);
        toast.success(tec.toasts.testStarted);
        const executionId = result?.data?.executionId;
        router.push(
          executionId
            ? `/weldconnect/executions/${executionId}`
            : `/weldconnect/executions?workflowId=${workflow.id}`,
        );
      },
      onError: () => {
        toast.error(tec.toasts.testFailed);
      },
    });
  };

  // The activation gate answers with the exact problem (`issues[].code`); show
  // that instead of the generic "not available yet" for e.g. a bad schedule.
  const publishErrorMessage = (err: unknown): string => {
    const messages = tec.publishIssues as Record<string, string>;
    const specific = getWorkflowIssueCodes(err).map((code) => messages[code]).find(Boolean);
    if (specific) return specific;
    return isUnsupportedWorkflowError(err) ? tec.toasts.publishUnsupported : tec.toasts.publishFailed;
  };

  const handlePause = () => {
    updateStatusMutation.mutate({ id: workflow.id, status: 'paused' }, {
      onSuccess: () => {
        setWorkflow((prev) => ({ ...prev, status: 'paused' }));
        toast.success(tec.toasts.workflowPaused);
      },
      onError: () => {
        toast.error(tec.toasts.pauseFailed);
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
    // Already live: saving is the publish. Nothing else changes state.
    if (status === 'active') {
      await handleSave(tec.toasts.changesPublished);
      return;
    }
    if (!(await handleSave())) return;
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
          setWorkflow((prev) => ({ ...prev, status: 'active' }));
          toast.success(tec.toasts.workflowPublished);
        },
        onError: (err) => {
          toast.error(publishErrorMessage(err));
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

    setWorkflow((prev) => ({
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

    const newStep: WorkflowStepBag = {
      id: `step-${Date.now()}`,
      type: actionType,
      name: actions[actionType]?.name || actionType,
      config: {},
      order: workflow.steps.length,
      position: undefined, // Let flow editor auto-position
    };

    // Determine which branch the new step belongs to, and where it goes
    let insertAt = workflow.steps.length;
    if (addStepSourceNodeId?.endsWith(ADD_STEP_AFTER_SUFFIX)) {
      // "Add step after" a condition or loop: same level, right after it
      // (steps at one level run in array order, whatever sits in between).
      const anchorId = addStepSourceNodeId.slice(0, -ADD_STEP_AFTER_SUFFIX.length);
      const anchorIndex = workflow.steps.findIndex((s) => s.id === anchorId);
      if (anchorIndex >= 0) {
        insertAt = anchorIndex + 1;
        if (workflow.steps[anchorIndex].parentBranchId) {
          newStep.parentBranchId = workflow.steps[anchorIndex].parentBranchId;
        }
      }
    } else if (addStepSourceNodeId) {
      if (addStepSourceNodeId.includes('_branch_') ||
          addStepSourceNodeId.endsWith('_if') ||
          addStepSourceNodeId.endsWith('_if_not') ||
          addStepSourceNodeId.endsWith('_each')) {
        // Adding directly from a branch node ("+" on If true / If false / multi-branch / For each item)
        newStep.parentBranchId = addStepSourceNodeId;
      } else {
        // Adding from a step that may itself be a branch child — inherit its branch
        const sourceStep = workflow.steps.find((s) => s.id === addStepSourceNodeId);
        if (sourceStep?.parentBranchId) {
          newStep.parentBranchId = sourceStep.parentBranchId;
        }
      }
    }

    const updatedSteps = [...workflow.steps.slice(0, insertAt), newStep, ...workflow.steps.slice(insertAt)];
    updatedSteps.forEach((step, i) => (step.order = i));

    setWorkflow({ ...workflow, steps: updatedSteps });
    setEditingStep(newStep);
    setAddStepSourceNodeId(null); // Clear after use
  }, [workflow, addStepSourceNodeId, t]);

  const handleUpdateStep = (stepId: string, data: Record<string, unknown>) => {
    setWorkflow({
      ...workflow,
      steps: workflow.steps.map((s) =>
        s.id === stepId ? { ...s, ...data } : s
      ),
    });
  };

  const handleUpdateConfig = useCallback((stepId: string, config: Record<string, unknown>) => {
    setWorkflow((prev) => ({
      ...prev,
      steps: prev.steps.map((s) =>
        s.id === stepId ? { ...s, config: { ...s.config, ...config } } : s
      ),
    }));
    // Also update editingStep if it's the same step
    setEditingStep((prev) =>
      prev?.id === stepId ? { ...prev, config: { ...prev.config, ...config } } : prev
    );
  }, []);

  const handleDeleteStep = useCallback((index: number) => {
    const stepToDelete = workflow.steps[index];
    if (!stepToDelete) return;

    // Recursively collect all step IDs that should be deleted
    const idsToDelete = new Set<string>();
    function collectDeletions(id: string, type: string, config?: unknown) {
      idsToDelete.add(id);
      if (isBranchingStepType(type)) {
        const branchIds = getConditionBranchIds({ id, type, config: config as ConditionStepConfig | undefined });
        branchIds.forEach((branchId) => {
          workflow.steps.forEach((s) => {
            if (s.parentBranchId === branchId) {
              collectDeletions(s.id || '', s.type || '', s.config);
            }
          });
        });
      }
    }
    collectDeletions(stepToDelete.id || '', stepToDelete.type || '', stepToDelete.config);

    const updatedSteps = workflow.steps
      .filter((s) => !idsToDelete.has(s.id || ''))
      .map((step, i) => ({ ...step, order: i }));
    setWorkflow((prev) => ({ ...prev, steps: updatedSteps }));
    setSelectedStepIndex(null);
    setEditingStep(null);
    setEditingBranch(null);
  }, [workflow.steps]);

  const resetTriggerPanel = useCallback(() => {
    setTriggerType('entity_event');
    setTriggerEntityType('');
    setTriggerEventType('');
    setScheduleType('recurring');
    setScheduleCronPreset('every_day_9am');
    setScheduleCustomCron('0 9 * * *');
    setScheduleTimezone('Europe/Amsterdam');
    setScheduleExecuteAt('');
    setIntegrationTriggerEventId('');
    setSourceWorkflowId('');
    setWorkflowCompleteTriggerOn('success');
    setWorkflowCompletePassOutput(false);
  }, []);

  const loadTriggerIntoPanel = useCallback((trigger: WorkflowTriggerBag) => {
    setTriggerType(trigger.type || 'entity_event');
    setTriggerEntityType((trigger.entityType as string | undefined) || '');
    setTriggerEventType((trigger.eventType as string | undefined) || '');
    setIntegrationTriggerEventId(trigger.type === 'integration_event' ? readIntegrationEventId(trigger) : '');

    const workflowComplete = trigger.type === 'workflow_complete'
      ? readWorkflowCompleteSettings(trigger)
      : DEFAULT_WORKFLOW_COMPLETE_SETTINGS;
    setSourceWorkflowId(workflowComplete.sourceWorkflowId);
    setWorkflowCompleteTriggerOn(workflowComplete.triggerOn);
    setWorkflowCompletePassOutput(workflowComplete.passOutput);

    // Load schedule settings if it's a schedule trigger
    if (trigger.type === 'schedule') {
      const schedule = readScheduleSettings(trigger, CRON_PRESETS);
      setScheduleType(schedule.scheduleType);
      setScheduleTimezone(schedule.timezone);
      setScheduleExecuteAt(schedule.executeAt);
      if (schedule.cronPresetId) setScheduleCronPreset(schedule.cronPresetId);
      if (schedule.customCron !== undefined) setScheduleCustomCron(schedule.customCron);
    }
  }, [CRON_PRESETS]);

  const handleSelectTrigger = useCallback(() => {
    // Open trigger panel for editing the first trigger
    if (workflow.triggers.length > 0) {
      loadTriggerIntoPanel(workflow.triggers[0]);
    } else {
      resetTriggerPanel();
    }
    setShowTriggerPanel(true);
    setShowRunsPanel(false);
    setShowAddActionPanel(false);
    setEditingStep(null);
    setEditingBranch(null);
    setSelectedStepIndex(null);
  }, [workflow.triggers, loadTriggerIntoPanel, resetTriggerPanel]);

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

  const handleStepsChange = useCallback((updatedSteps: WorkflowStep[]) => {
    setWorkflow((prev) => ({ ...prev, steps: updatedSteps as unknown as WorkflowStepBag[] }));
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
    const step = workflow.steps.find((s) => s.id === addSubAgentForStepId);
    if (!step) return;
    const currentIds: string[] = ((step.config as Record<string, unknown> | undefined)?.subAgentIds as string[] | undefined) || [];
    const currentNames: Record<string, string> = ((step.config as Record<string, unknown> | undefined)?.subAgentNames as Record<string, string> | undefined) || {};
    handleUpdateConfig(addSubAgentForStepId, {
      subAgentIds: [...currentIds, agentId],
      subAgentNames: { ...currentNames, [agentId]: agentName },
    });
    setAddSubAgentForStepId(null);
  }, [addSubAgentForStepId, workflow.steps, handleUpdateConfig]);

  // Memoised: WorkflowCanvas re-syncs its nodes whenever `steps`/`trigger` change,
  // so fresh objects on every render would loop (React #185).
  const sortedSteps: WorkflowStep[] = useMemo(
    () => [...workflow.steps]
      .sort((a, b) => ((a.order as number | undefined) || 0) - ((b.order as number | undefined) || 0))
      .map(asWorkflowStep),
    [workflow.steps],
  );
  const canvasTrigger = useMemo(() => asTriggerConfig(workflow.triggers[0]), [workflow.triggers]);

  const applyTriggerData: ApplyTriggerData = (triggerData) => {
    if (workflow.triggers.length > 0) {
      setWorkflow({ ...workflow, triggers: [{ ...workflow.triggers[0], ...triggerData }] });
    } else {
      setWorkflow({ ...workflow, triggers: [{ id: `trigger-${Date.now()}`, ...triggerData }] });
    }
  };

  const triggerForm: TriggerFormApi = {
    triggerType,
    setTriggerType,
    triggerEntityType,
    setTriggerEntityType,
    triggerEventType,
    setTriggerEventType,
    integrationTriggerEventId,
    setIntegrationTriggerEventId,
    scheduleType,
    setScheduleType,
    scheduleCronPreset,
    setScheduleCronPreset,
    scheduleCustomCron,
    setScheduleCustomCron,
    scheduleTimezone,
    setScheduleTimezone,
    scheduleExecuteAt,
    setScheduleExecuteAt,
    sourceWorkflowId,
    setSourceWorkflowId,
    workflowCompleteTriggerOn,
    setWorkflowCompleteTriggerOn,
    workflowCompletePassOutput,
    setWorkflowCompletePassOutput,
    showWebhookSecret,
    setShowWebhookSecret,
  };

  const handleOpenEditorTab = () => {
    setShowRunsPanel(false);
    router.replace(editorHref ?? `${basePath}/${workflow.id}/edit`, { scroll: false });
  };

  const handleOpenRunsTab = () => {
    setShowRunsPanel(true);
    setShowTriggerPanel(false);
    setEditingStep(null);
    setEditingBranch(null);
    setShowMobileSidebar(true);
    router.replace(`${basePath}/${workflow.id}/edit?panel=runs`, { scroll: false });
  };

  const handleDeleteEditingStep = () => {
    if (!editingStep) return;
    const stepIndex = workflow.steps.findIndex((s) => s.id === editingStep.id);
    if (stepIndex !== -1) {
      handleDeleteStep(stepIndex);
      setEditingStep(null);
    }
  };

  const closeSubAgentEditor = () => {
    setEditSubAgentId(null);
    setSubAgentForm(null);
  };

  const handleSaveSubAgent = () => {
    if (!editSubAgentId || !subAgentForm) return;
    if (!subAgentForm.name.trim() || !subAgentForm.systemPrompt.trim()) {
      toast.error(tec.toasts.nameAndPromptRequired);
      return;
    }
    updateSubAgentMutation.mutate({ id: editSubAgentId, data: subAgentForm });
  };

  const actionButtonProps: EditorActionButtonsProps = {
    module,
    hideTemplatesAndAi,
    hidePublish,
    hasBlockingIssues,
    stepCount: workflow.steps.length,
    incompleteCount,
    isTesting,
    isSaving,
    publishLabel,
    status,
    isDirty,
    onGenerate: () => setShowGenerateDialog(true),
    onTest: () => setShowTestDialog(true),
    onJumpToIssue: jumpToFirstIssue,
    onSave: () => handleSave(),
    onPublish: handlePublish,
    onPause: handlePause,
  };

  // Right sidebar: the runs, trigger, add-action, branch or step panel (or the overview when none is open).
  const renderSidebarPanel = () => {
    if (showRunsPanel) {
      return (
        <RunsPanel
          workflowId={workflow.id}
          onClose={() => {
            setShowRunsPanel(false);
            setShowMobileSidebar(false);
          }}
        />
      );
    }
    if (showTriggerPanel) {
      return (
        <TriggerPanel
          module={module}
          hasTrigger={workflow.triggers.length > 0}
          warning={getTriggerWarning(workflow.triggers?.[0], triggerType)}
          filteredTriggerTypes={filteredTriggerTypes}
          groupedEntityEvents={groupedEntityEvents}
          filteredEntityEvents={filteredEntityEvents}
          integrationTriggers={integrationTriggers}
          workflowsForChaining={workflowsForChaining}
          webhookData={webhookData}
          workflowId={workflow.id}
          cronPresets={CRON_PRESETS}
          oneTimeScheduleAllowed={oneTimeScheduleAllowed}
          form={triggerForm}
          initialTriggerData={initialTriggerData}
          applyTriggerData={applyTriggerData}
          onClose={() => {
            setShowTriggerPanel(false);
            setShowMobileSidebar(false);
          }}
        />
      );
    }
    if (showAddActionPanel) {
      return (
        <AddActionPanel
          module={module}
          actions={filteredActionTypes}
          categoryLabels={categoryLabels}
          onSelectAction={(actionId) => {
            handleAddAction(actionId);
            setShowAddActionPanel(false);
          }}
          onClose={() => {
            setShowAddActionPanel(false);
            setShowMobileSidebar(false);
          }}
        />
      );
    }
    if (editingBranch) {
      return (
        <BranchEditPanel
          branch={editingBranch}
          steps={workflow.steps}
          onSelectStep={handleSelectStep}
          onAddStep={() => {
            setEditingBranch(null);
            setShowAddActionPanel(true);
            setAddStepSourceNodeId(editingBranch.branchNodeId);
          }}
          onClose={() => {
            setEditingBranch(null);
            setShowMobileSidebar(false);
          }}
        />
      );
    }
    if (editingStep) {
      return (
        <EditStepPanel
          step={editingStep}
          steps={workflow.steps}
          triggerType={workflow.triggers?.[0]?.type}
          unsupported={isStepUnsupported(editingStep.type)}
          unknownVariables={getUnknownVariables(editingStep)}
          emailAccounts={emailAccounts}
          workspaceMembers={workspaceMembers}
          workflowVariables={workflowVariables}
          extraVariableGroups={extraVariableGroups}
          excludeVariableGroups={excludeVariableGroups}
          onStepChange={setEditingStep}
          onUpdateStep={handleUpdateStep}
          onDelete={handleDeleteEditingStep}
          onAddStepAfter={
            isBranchingStepType(editingStep.type)
              ? () => handleAddStep(`${editingStep.id}${ADD_STEP_AFTER_SUFFIX}`)
              : undefined
          }
          onClose={() => {
            setEditingStep(null);
            setShowMobileSidebar(false);
          }}
        />
      );
    }
    return (
      <OverviewPanel
        steps={workflow.steps}
        triggerLocked={triggerLocked}
        triggerIssue={triggerIssue}
        triggerTypeId={workflow.triggers?.[0]?.type}
        triggerTypes={TRIGGER_TYPES}
        allStepsConfigured={incompleteStepIds.size === 0}
        actionTypes={filteredActionTypes}
        categoryLabels={categoryLabels}
        hideTemplatesAndAi={hideTemplatesAndAi}
        isStepUnsupported={isStepUnsupported}
        getUnknownVariables={getUnknownVariables}
        onSelectTrigger={handleSelectTrigger}
        onSelectStep={handleSelectStep}
        onOpenTemplates={() => setShowTemplateDialog(true)}
        onCloseMobile={() => setShowMobileSidebar(false)}
      />
    );
  };

  return (
    <div className="h-full flex flex-col bg-muted/30 overflow-hidden">
      <EditorHeader
        hideNavTabs={hideNavTabs}
        nav={{
          module,
          basePath,
          workflowId: workflow.id,
          showRunsPanel,
          replaceExecutionsTab,
          onOpenEditorTab: handleOpenEditorTab,
          onOpenRunsTab: handleOpenRunsTab,
        }}
        actions={actionButtonProps}
        onToggleMobileSidebar={() => setShowMobileSidebar(!showMobileSidebar)}
      />

      {/* Portal action buttons to external nav when hideNavTabs */}
      {hideNavTabs && actionsPortalRef?.current && createPortal(
        <EditorActionButtons {...actionButtonProps} />,
        actionsPortalRef.current
      )}

      {/* Main Content - Flow Editor + Sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Flow Editor Canvas */}
        <div className="flex-1 relative overflow-hidden">
          {!triggerLocked && !workflow.triggers[0] && sortedSteps.length === 0 && !showTriggerPanel ? (
            <TriggerEmptyState
              allowedTypes={filteredTriggerTypes.map((type) => type.id)}
              onSelectType={(type) => {
                setTriggerType(type);
                setWorkflow((prev) => ({
                  ...prev,
                  triggers: [{ id: `trigger-${Date.now()}`, ...initialTriggerData(type) }],
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
            trigger={canvasTrigger}
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
            labels={t.weldconnect.flowEditor as WorkflowCanvasLabels}
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
          <TriggerRecordFieldsProvider value={triggerRecordFields}>
            {renderSidebarPanel()}
          </TriggerRecordFieldsProvider>
        </div>
      </div>

      <TestRunDialog
        open={showTestDialog}
        onOpenChange={setShowTestDialog}
        trigger={triggerLocked ? undefined : firstTrigger}
        entityLabel={filteredEntityEvents.find((entity) => entity.entityType === savedEntityType)?.label ?? savedEntityType}
        recordFields={testRecordFields}
        testerEmail={testerEmail}
        hasUnsavedChanges={isDirty}
        isRunning={isTesting}
        onRun={handleRunTest}
      />

      <WorkflowTemplateDialog
        open={showTemplateDialog}
        onOpenChange={setShowTemplateDialog}
        onSelectTemplate={(template) => {
          if (template.id === 'blank') {
            // Reset to blank workflow
            setWorkflow((prev) => ({ ...prev, triggers: [], steps: [] }));
            setTriggerType('entity_event');
            setTriggerEntityType('');
            setTriggerEventType('');
            setEditingStep(null);
            setSelectedStepIndex(null);
            return;
          }

          if (template.trigger && template.steps) {
            // Apply template trigger and steps
            setWorkflow((prev) => ({
              ...prev,
              triggers: [template.trigger as WorkflowTriggerBag],
              steps: template.steps as unknown as WorkflowStepBag[],
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

      {module !== 'helpdesk' && !hideTemplatesAndAi && (
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

      <SubAgentPickerDialog
        stepId={addSubAgentForStepId}
        steps={workflow.steps}
        savedAgents={savedAgents}
        onSelect={handleSelectSubAgent}
        onClose={() => setAddSubAgentForStepId(null)}
      />

      <SubAgentEditDialog
        open={!!editSubAgentId}
        form={subAgentForm}
        setForm={setSubAgentForm}
        mcpConnections={mcpConnections}
        isSaving={updateSubAgentMutation.isPending}
        onClose={closeSubAgentEditor}
        onSave={handleSaveSubAgent}
      />
    </div>
  );
}
