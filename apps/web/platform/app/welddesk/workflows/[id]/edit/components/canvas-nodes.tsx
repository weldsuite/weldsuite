import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import {
  Target,
  Plus,
  Clock,
  GitBranch,
  Bot,
  ChevronDown,
  GripVertical,
  MessageSquareDashed,
  Search,
  ListChecks,
  BookOpen,
  CornerDownRight,
  AlertTriangle,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getActionMeta,
  HELPDESK_ROUTING_TRIGGERS,
  WORKFLOW_CHANNELS,
  WORKFLOW_AUDIENCES,
  ACTION_CATEGORIES,
  getAvailableActions,
  getHelpdeskActionTypes,
  getHelpdeskActionCategories,
  getWorkflowChannels,
  getWorkflowAudiences,
  isTerminalAction,
} from '../helpdesk-workflow-constants';
import type { WorkflowStep, WorkflowTrigger, DerivedPath } from './canvas-utils';
import { STEP_H, REPLY_BTN_H, BRANCH_LABEL_H, ADD_BTN_ROW_H } from './canvas-utils';

// ============================================================================
// Helper functions
// ============================================================================

const MAX_PILLS = 2;

export function getTriggerLabel(trigger: WorkflowTrigger | null, fallbackSelect = 'Select a trigger', fallbackConfigured = 'Configured trigger'): string {
  if (!trigger) return fallbackSelect;
  const m = HELPDESK_ROUTING_TRIGGERS.find(
    (t) => t.entityType === trigger.entityType && t.eventType === trigger.eventType,
  );
  return m?.label ?? trigger.eventType ?? fallbackConfigured;
}

export function getTriggerChannels(trigger: WorkflowTrigger | null): string[] {
  return trigger?.config?.channels || [];
}

export function getTriggerAudience(trigger: WorkflowTrigger | null): string[] {
  return trigger?.config?.audience || [];
}

export function ChannelPills({ channels, allChannelsLabel = 'All channels', channelDefs }: { channels: string[]; allChannelsLabel?: string; channelDefs?: Array<{ value: string; label: string }> }) {
  if (channels.length === 0) {
    return <span className="text-xs text-muted-foreground">{allChannelsLabel}</span>;
  }
  const visible = channels.slice(0, MAX_PILLS);
  const remaining = channels.length - MAX_PILLS;
  const lookupChannels = channelDefs ?? WORKFLOW_CHANNELS;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visible.map((ch) => {
        const def = lookupChannels.find((c) => c.value === ch);
        return (
          <span
            key={ch}
            className="inline-flex items-center gap-1 rounded-full bg-teal-100 dark:bg-teal-900/30 px-2 py-0.5 text-[11px] font-medium text-teal-700 dark:text-teal-300"
          >
            {def?.label || ch}
          </span>
        );
      })}
      {remaining > 0 && (
        <span className="text-[11px] text-muted-foreground font-medium">+{remaining} more</span>
      )}
    </div>
  );
}

export function AudiencePills({ audience, everyoneLabel = 'Everyone', audienceDefs }: { audience: string[]; everyoneLabel?: string; audienceDefs?: Array<{ value: string; label: string }> }) {
  if (audience.length === 0) {
    return <span className="text-xs text-muted-foreground">{everyoneLabel}</span>;
  }
  const lookupAudiences = audienceDefs ?? WORKFLOW_AUDIENCES;
  const label = audience
    .map((a) => lookupAudiences.find((au) => au.value === a)?.label || a)
    .join(' and ');
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
      {label}
    </span>
  );
}

export function formatDuration(c: Record<string, any> | undefined, notSetLabel = 'Not set'): string {
  if (!c) return notSetLabel;
  if (c.days) return `${c.days}d`;
  if (c.hours) return `${c.hours}h`;
  if (c.minutes) return `${c.minutes}m`;
  if (c.seconds) return `${c.seconds}s`;
  if (c.duration) return `${c.duration} ${c.durationUnit || 'min'}`;
  return notSetLabel;
}

export function previewText(step: WorkflowStep): string {
  const c = step.config || {};
  switch (step.type) {
    case 'send_message': return (c.message as string) || 'No message set';
    case 'send_choices': return (c.prompt as string) || (c.message as string) || 'Choose an option';
    case 'collect_input':
    case 'collect_customer_info':
      return (c.prompt as string) || (c.message as string) || 'Please provide your information';
    case 'suggest_articles': return (c.message as string) || 'Here are some articles that might help';
    case 'send_reply': return (c.message as string) || 'Reply';
    case 'send_email': return (c.subject as string) || (c.message as string) || 'Email';
    case 'ai_auto_reply': return 'Handles all messages until escalation';
    case 'ai_classify': return 'AI classifies the conversation';
    case 'ai_summarize': return 'AI summarizes the conversation';
    case 'ai_translate': return 'AI translates the message';
    case 'ai_sentiment': return 'AI detects sentiment';
    default: return '';
  }
}

export function actionSummary(step: WorkflowStep): string {
  const c = step.config || {};
  switch (step.type) {
    case 'assign_conversation': return c.assigneeName || c.strategy || 'Not configured';
    case 'unassign_conversation': return 'Remove assignment';
    case 'tag_conversation': return Array.isArray(c.tags) ? c.tags.join(', ') : 'No tags';
    case 'change_conversation_status': return (c.status as string) || 'Not set';
    case 'close_conversation': return 'Close';
    case 'snooze_conversation': return c.duration ? `${c.duration} ${c.durationUnit || 'min'}` : 'Not set';
    case 'change_priority': return (c.priority as string) || 'Not set';
    case 'add_internal_note': return (c.content as string)?.slice(0, 40) || 'Note';
    case 'create_ticket_from_conversation': return 'Create ticket';
    case 'apply_sla': return (c.slaName as string) || 'Apply SLA';
    case 'trigger_csat': return 'Send survey';
    case 'trigger_webhook': return (c.url as string)?.slice(0, 40) || 'Not configured';
    case 'set_conversation_attribute': return c.attribute ? `${c.attribute}` : 'Not set';
    case 'set_contact_attribute': return c.attribute ? `${c.attribute}` : 'Not set';
    case 'set_variable': return c.name ? `${c.name}` : 'Not set';
    case 'send_notification': return (c.title as string) || 'Notification';
    case 'send_email': return (c.subject as string) || 'Email';
    case 'manual_step': return 'Waiting for teammate';
    case 'wait_for_reply': return 'Waiting for reply';
    default: return step.name;
  }
}

function getStepSummary(step: WorkflowStep): string {
  const messageTypes = new Set([
    'send_message', 'send_reply', 'send_choices', 'collect_input',
    'collect_customer_info', 'suggest_articles', 'ai_auto_reply',
    'send_email', 'ai_classify', 'ai_summarize', 'ai_translate', 'ai_sentiment',
  ]);
  return messageTypes.has(step.type) ? previewText(step) : actionSummary(step);
}

// ── Path colors ────────────────────────────────────────────────────────────

const PATH_COLORS = [
  { bg: 'bg-blue-500', text: 'text-white' },
  { bg: 'bg-emerald-500', text: 'text-white' },
  { bg: 'bg-amber-500', text: 'text-white' },
  { bg: 'bg-violet-500', text: 'text-white' },
  { bg: 'bg-rose-500', text: 'text-white' },
  { bg: 'bg-cyan-500', text: 'text-white' },
  { bg: 'bg-orange-500', text: 'text-white' },
  { bg: 'bg-teal-500', text: 'text-white' },
];

function getPathColor(index: number) {
  return PATH_COLORS[index % PATH_COLORS.length];
}

// ============================================================================
// Suggested actions for inline add step
// ============================================================================

const SUGGESTED_ACTIONS = [
  'ai_auto_reply',
  'delay',
  'tag_conversation',
  'assign_conversation',
  'close_conversation',
  'condition',
] as const;

// ============================================================================
// InlineAddStepPopover
// ============================================================================

export function InlineAddStepPopover({
  sourceNodeId,
  onAddAction,
  variant = 'circle',
  sourceStepType,
  showSuggestions,
  trigger,
}: {
  sourceNodeId?: string;
  onAddAction: (actionType: string, sourceNodeId?: string) => void;
  variant?: 'circle' | 'button';
  sourceStepType?: string;
  showSuggestions?: boolean;
  trigger?: { entityType?: string; eventType?: string } | null;
}) {
  const { t } = useI18n();
  const cn_ = t.helpdesk.canvasNodes;
  const wc = t.helpdesk.workflowConstants;
  const translatedActionTypes = React.useMemo(() => getHelpdeskActionTypes(wc), [wc]);
  const translatedActionCategories = React.useMemo(() => getHelpdeskActionCategories(wc), [wc]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSelect = (actionType: string) => {
    setOpen(false);
    setSearch('');
    setExpanded(false);
    onAddAction(actionType, sourceNodeId);
  };

  const needle = search.toLowerCase();
  const availableActions = getAvailableActions(trigger, translatedActionTypes);
  const useSuggestions = showSuggestions && !expanded && !needle;

  return (
    <div className="relative" ref={ref}>
      {variant === 'button' ? (
        <Button
          type="button"
          variant="ghost"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          className="flex items-center justify-center gap-1.5 w-full rounded-lg border border-dashed border-muted-foreground/30 py-2 text-xs font-medium text-muted-foreground hover:border-muted-foreground/50 hover:text-primary hover:bg-muted transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {cn_.addStep}
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          className={cn(
            'w-6 h-6 rounded-full border-2 border-dashed border-muted-foreground/30 shrink-0',
            'flex items-center justify-center self-center',
            'hover:border-muted-foreground/50 hover:text-primary text-muted-foreground/40 transition-colors',
          )}
        >
          <Plus className="h-3 w-3" />
        </Button>
      )}

      {open && (
        <div
          className="absolute z-50 top-full mt-1 left-0 w-[240px] rounded-lg border bg-popover shadow-lg"
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={cn_.searchPlaceholder}
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </div>

          {useSuggestions ? (
            <div className="p-1">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-1.5 pb-1">
                {cn_.suggestedNextSteps}
              </p>
              {SUGGESTED_ACTIONS.map((actionId) => {
                const action = availableActions.find((a) => a.id === actionId);
                if (!action) return null;
                const Icon = action.icon;
                const meta = getActionMeta(action.id);
                return (
                  <Button
                    key={action.id}
                    type="button"
                    variant="ghost"
                    onClick={() => handleSelect(action.id)}
                    className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-left hover:bg-muted transition-colors"
                  >
                    <div className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md', meta.bgColor)}>
                      <Icon className={cn('h-3.5 w-3.5', meta.color)} />
                    </div>
                    <span className="text-sm font-medium truncate">{action.name}</span>
                  </Button>
                );
              })}
              <Button
                type="button"
                variant="ghost"
                onClick={() => setExpanded(true)}
                className="w-full px-2 py-1.5 text-sm font-medium text-primary hover:underline text-left mt-0.5"
              >
                {cn_.viewMore}
              </Button>
            </div>
          ) : (
            <div className="max-h-[280px] overflow-y-auto p-1">
              {translatedActionCategories.map(({ id: catId, label: catLabel }) => {
                let actions = availableActions.filter((a) => a.category === catId);
                if (needle) {
                  actions = actions.filter(
                    (a) =>
                      a.name.toLowerCase().includes(needle) ||
                      a.description.toLowerCase().includes(needle),
                  );
                }
                if (actions.length === 0) return null;

                return (
                  <div key={catId} className="mb-1">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-1.5 pb-0.5">
                      {catLabel}
                    </p>
                    {actions.map((action) => {
                      const Icon = action.icon;
                      return (
                        <Button
                          key={action.id}
                          type="button"
                          variant="ghost"
                          onClick={() => handleSelect(action.id)}
                          className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left hover:bg-muted transition-colors"
                        >
                          <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="text-sm truncate">{action.name}</span>
                        </Button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ReplyButtonInput
// ============================================================================

export function ReplyButtonInput({
  value,
  autoFocus,
  onChange,
  onRemove,
}: {
  value: string;
  autoFocus?: boolean;
  onChange: (val: string) => void;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const cn_ = t.helpdesk.canvasNodes;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [autoFocus]);

  return (
    <div className="group flex items-center gap-0.5 flex-1 min-w-0">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        placeholder={cn_.buttonLabel}
        className="flex-1 min-w-0 rounded-md border border-cyan-300 dark:border-cyan-700 bg-cyan-50 dark:bg-cyan-950/30 px-2.5 py-1.5 text-xs font-medium text-cyan-800 dark:text-cyan-200 outline-none focus:ring-2 focus:ring-cyan-400 dark:focus:ring-cyan-600 placeholder:text-cyan-400"
      />
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-900/30 text-muted-foreground hover:text-red-600 transition-all"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

// ============================================================================
// StepCard — compact row inside PathNode
// ============================================================================

export function StepCard({
  step,
  isSelected,
  onClick,
}: {
  step: WorkflowStep;
  isSelected: boolean;
  onClick: () => void;
}) {
  const meta = getActionMeta(step.type);
  const Icon = meta.icon;
  const summary = getStepSummary(step);

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        'flex items-center gap-2 w-full rounded-lg border p-2.5 text-left group hover:border-muted-foreground/40',
        isSelected ? 'ring-1 ring-blue-400 bg-background' : 'bg-background',
      )}
    >
      <GripVertical className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground/60 shrink-0 cursor-grab active:cursor-grabbing" />
      <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md border', meta.bgColor, meta.borderColor)}>
        <Icon className={cn('h-3.5 w-3.5', meta.color)} />
      </div>
      <div className="min-w-0 flex-1 -space-y-[1px]">
        <p className="text-xs font-medium truncate">{step.name}</p>
        {summary && <p className="text-[10px] text-muted-foreground truncate">{summary}</p>}
      </div>
    </Button>
  );
}

// ============================================================================
// ConnectorDot — small circle on node edges for SVG edge connections
// ============================================================================

function ConnectorDot({ side, connectorId }: { side: 'left' | 'right'; connectorId?: string }) {
  return (
    <div
      data-connector-id={connectorId}
      className={cn(
        'absolute w-[9px] h-[9px] rounded-full bg-white border border-blue-500 z-10',
        side === 'left' ? '-left-1' : '-right-1',
      )}
      style={{ top: '50%', transform: 'translateY(-50%)' }}
    />
  );
}

// ============================================================================
// TriggerNode
// ============================================================================

export function getTriggerDescription(trigger: WorkflowTrigger | null): string {
  if (!trigger) return '';
  const m = HELPDESK_ROUTING_TRIGGERS.find(
    (t) => t.entityType === trigger.entityType && t.eventType === trigger.eventType,
  );
  return m?.description ?? '';
}

export function getTriggerCategory(trigger: WorkflowTrigger | null, triggerLabel = 'Trigger'): string {
  if (!trigger) return triggerLabel;
  const m = HELPDESK_ROUTING_TRIGGERS.find(
    (t) => t.entityType === trigger.entityType && t.eventType === trigger.eventType,
  );
  if (m?.category === 'conversation') return 'Conversation';
  if (m?.category === 'ticket') return 'Ticket';
  return triggerLabel;
}

export function TriggerNode({
  trigger,
  isSelected,
  onClick,
  onDragStart,
  style,
}: {
  trigger: WorkflowTrigger | null;
  isSelected: boolean;
  onClick: () => void;
  onDragStart?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const cn_ = t.helpdesk.canvasNodes;

  return (
    <div
      style={style}
      className="relative select-none"
      onMouseDown={onDragStart}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {/* "Trigger" tab label */}
      <div className="inline-flex items-center gap-1.5 rounded-t-lg border border-b-0 bg-background px-3 py-1.5">
        <Target className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">{cn_.triggerTab}</span>
      </div>

      {/* Card */}
      <div
        className={cn(
          'w-[300px] rounded-xl rounded-tl-none border bg-background px-4 pt-3.5 pb-4 text-left transition-all cursor-pointer relative',
          isSelected && 'ring-1 ring-blue-400',
        )}
      >
        {/* Connector dot on right edge */}
        <ConnectorDot side="right" connectorId="trigger:out" />

        {/* Header row: icon + name */}
        <div className="flex items-start gap-2.5">
          <p className="flex-1 text-sm font-semibold leading-snug pt-0.5">{getTriggerLabel(trigger, cn_.selectTrigger)}</p>
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground mt-2.5">{getTriggerDescription(trigger)}</p>
      </div>
    </div>
  );
}

// ============================================================================
// PathNode — vertical card with steps, branch connectors, add-step footer
// ============================================================================

export function PathNode({
  path,
  pathIndex,
  allSteps,
  selectedNodeId,
  onSelectStep,
  onSelectBranch,
  onAddActionInline,
  onAddStep,
  onUpdateConfig,
  onReorderSteps,
  trigger,
  onDragStart,
  style,
}: {
  path: DerivedPath;
  pathIndex: number;
  allSteps: WorkflowStep[];
  selectedNodeId: string | null;
  onSelectStep: (index: number) => void;
  onSelectBranch: (branchNodeId: string, branchType: string, parentConditionId: string, parentConditionStepIndex: number) => void;
  onAddActionInline?: (actionType: string, sourceNodeId?: string) => void;
  onAddStep?: (sourceNodeId?: string) => void;
  onUpdateConfig?: (stepId: string, config: Record<string, any>) => void;
  onReorderSteps?: (reordered: WorkflowStep[]) => void;
  trigger?: { entityType?: string; eventType?: string } | null;
  onDragStart?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const cn_ = t.helpdesk.canvasNodes;
  const [collapsed, setCollapsed] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const isSelected = selectedNodeId === path.id;
  const color = getPathColor(pathIndex);
  const lastStepId = path.steps.length > 0 ? path.steps[path.steps.length - 1].step.id : path.id;
  const lastStepType = path.steps.length > 0 ? path.steps[path.steps.length - 1].step.type : undefined;
  const lastStepIsTerminal = lastStepType ? isTerminalAction(lastStepType) : false;

  const pathLabel = path.id === 'root' ? cn_.rootPath : path.sourceLabel;

  return (
    <div
      style={style}
      className="relative select-none"
      onMouseDown={onDragStart}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Tab label */}
      <div className="inline-flex items-center gap-1.5 rounded-t-lg border border-b-0 bg-background px-3 py-1.5">
        <div className="flex w-[16px] h-[16px] shrink-0 items-center justify-center rounded-[5px] border border-gray-200 dark:border-border bg-gray-100 dark:bg-secondary text-[10px] font-mono text-gray-500 dark:text-gray-400">
          <span className="relative top-0">{pathIndex + 1}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            if (path.sourceStepId) {
              const parentStep = allSteps.find((s) => s.id === path.sourceStepId);
              const parentIdx = parentStep ? allSteps.indexOf(parentStep) : 0;
              onSelectBranch(path.id, path.sourceLabel.toLowerCase(), path.sourceStepId, parentIdx);
            }
          }}
          className="text-xs font-medium text-muted-foreground"
        >
          {pathLabel}
        </Button>
        {path.hasWarning && (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        )}
      </div>

      {/* Card */}
      <div
        className={cn(
          'w-[320px] rounded-xl rounded-tl-none border bg-background transition-all relative',
          isSelected && 'ring-1 ring-blue-400',
        )}
      >
      {/* Inbound connector dot */}
      <ConnectorDot side="left" connectorId={`path:${path.id}:in`} />

      {/* Body */}
      {!collapsed && (
        <div className="px-2.5 py-2 space-y-1">
          {path.steps.length === 0 && (
            <div className="text-center py-4">
              <p className="text-xs text-muted-foreground mb-2">{cn_.noSteps}</p>
            </div>
          )}

          {path.steps.map(({ step, index: stepIndex }, localIdx) => (
            <React.Fragment key={step.id}>
            {/* "Add step" button rendered above the terminal action */}
            {lastStepIsTerminal && isTerminalAction(step.type) && localIdx === path.steps.length - 1 && (
              <div className="pt-1 pb-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Use the step before this terminal as source, or the path id if it's the first step
                    const prevStepId = localIdx > 0 ? path.steps[localIdx - 1].step.id : path.id;
                    onAddStep?.(prevStepId);
                  }}
                  className="flex items-center justify-center gap-1.5 w-full rounded-lg border border-dashed border-muted-foreground/30 py-2 text-xs font-medium text-muted-foreground hover:border-muted-foreground/50 hover:text-primary hover:bg-muted transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {cn_.addStep}
                </Button>
              </div>
            )}
            <div
              className={cn(
                'relative transition-opacity',
                dragIndex !== null && dragOverIndex === localIdx && 'border-t-2 border-primary',
                dragIndex === localIdx && 'opacity-40',
              )}
              draggable={!!onReorderSteps}
              onDragStart={(e) => {
                setDragIndex(localIdx);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                // Block invalid drops involving terminal actions
                if (dragIndex !== null && onReorderSteps) {
                  const draggedStep = path.steps[dragIndex]?.step;
                  const targetStep = path.steps[localIdx]?.step;
                  const isLast = localIdx === path.steps.length - 1;
                  // Terminal action being moved before another step
                  if (draggedStep && isTerminalAction(draggedStep.type) && !isLast) {
                    e.dataTransfer.dropEffect = 'none';
                    setDragOverIndex(null);
                    return;
                  }
                  // Non-terminal being moved after a terminal (to the end when last is terminal)
                  if (draggedStep && targetStep && !isTerminalAction(draggedStep.type) && isLast && isTerminalAction(targetStep.type)) {
                    e.dataTransfer.dropEffect = 'none';
                    setDragOverIndex(null);
                    return;
                  }
                }
                e.dataTransfer.dropEffect = 'move';
                setDragOverIndex(localIdx);
              }}
              onDragLeave={() => setDragOverIndex(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== localIdx && onReorderSteps) {
                  // Block moves that violate terminal action constraints
                  const draggedStep = path.steps[dragIndex]?.step;
                  const isTargetLast = localIdx === path.steps.length - 1;
                  const targetStep = path.steps[localIdx]?.step;
                  if (draggedStep && isTerminalAction(draggedStep.type) && !isTargetLast) {
                    setDragIndex(null);
                    setDragOverIndex(null);
                    return;
                  }
                  if (draggedStep && targetStep && !isTerminalAction(draggedStep.type) && isTargetLast && isTerminalAction(targetStep.type)) {
                    setDragIndex(null);
                    setDragOverIndex(null);
                    return;
                  }
                  const pathStepIds = path.steps.map((s) => s.step.id);
                  const reordered = [...allSteps];
                  // Find the actual indices in allSteps
                  const fromId = pathStepIds[dragIndex];
                  const toId = pathStepIds[localIdx];
                  const fromIdx = reordered.findIndex((s) => s.id === fromId);
                  const toIdx = reordered.findIndex((s) => s.id === toId);
                  if (fromIdx >= 0 && toIdx >= 0) {
                    const [moved] = reordered.splice(fromIdx, 1);
                    reordered.splice(toIdx, 0, moved);
                    // Re-assign order
                    onReorderSteps(reordered.map((s, i) => ({ ...s, order: i })));
                  }
                }
                setDragIndex(null);
                setDragOverIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDragOverIndex(null);
              }}
            >
              <StepCard
                step={step}
                isSelected={selectedNodeId === step.id}
                onClick={() => onSelectStep(stepIndex)}
              />

              {/* Reply button inputs below send_choices */}
              {step.type === 'send_choices' && (() => {
                const opts: Array<{ label?: string; value?: string }> =
                  Array.isArray(step.config?.options) ? step.config!.options : [];
                const isFresh = opts.length === 1 && (opts[0]?.value || '').startsWith('btn_');

                const handleRename = (oi: number, val: string) => {
                  if (!onUpdateConfig) return;
                  const updated = opts.map((o, i) => i === oi ? { ...o, label: val } : o);
                  onUpdateConfig(step.id, { options: updated });
                };

                const handleRemove = (oi: number) => {
                  if (!onUpdateConfig || opts.length <= 1) return;
                  onUpdateConfig(step.id, { options: opts.filter((_, i) => i !== oi) });
                };

                const handleAdd = () => {
                  if (!onUpdateConfig) return;
                  onUpdateConfig(step.id, {
                    options: [...opts, { label: cn_.addButton, value: `btn_${Date.now()}` }],
                  });
                };

                return (
                  <div className="ml-2 mt-1 space-y-1 relative">
                    {opts.map((opt, oi) => (
                      <div key={opt.value || oi} className="flex items-center gap-1 relative">
                        <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                        <ReplyButtonInput
                          value={opt.label || ''}
                          autoFocus={isFresh && oi === 0}
                          onChange={(val) => handleRename(oi, val)}
                          onRemove={opts.length > 1 ? () => handleRemove(oi) : undefined}
                        />
                        {/* Connector dot for this option */}
                        <div data-connector-id={`step:${step.id}:opt:${opt.value || oi}`} className="absolute -right-[15px] top-1/2 -translate-y-1/2 w-[9px] h-[9px] rounded-full bg-white border border-blue-500 z-10" />
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={(e) => { e.stopPropagation(); handleAdd(); }}
                      className="flex items-center justify-center gap-1 w-full rounded-md border border-dashed border-muted-foreground/30 py-1 text-[11px] font-medium text-muted-foreground hover:border-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      <Plus className="h-3 w-3" />
                      {cn_.addButton}
                    </Button>
                  </div>
                );
              })()}

              {/* Branch labels below ai_auto_reply (WeldAgent) */}
              {step.type === 'ai_auto_reply' && (() => {
                const defs = [
                  { value: 'escalated', label: 'Escalated' },
                  { value: 'resolved', label: 'Resolved' },
                ];
                return (
                  <div className="ml-2 mt-1 space-y-0.5 relative">
                    {defs.map((bd) => {
                      const labelColor =
                        bd.value === 'resolved'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-amber-700 dark:text-amber-400';
                      return (
                        <div key={bd.value} className="flex items-center gap-2 py-1.5 relative">
                          <GitBranch className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                          <span className={cn('text-[11px] font-medium', labelColor)}>{bd.label}</span>
                          <div data-connector-id={`step:${step.id}:branch:${bd.value}`} className="absolute -right-[15px] top-1/2 -translate-y-1/2 w-[9px] h-[9px] rounded-full bg-white border border-blue-500 z-10" />
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* Branch labels below condition */}
              {step.type === 'condition' && (() => {
                const condBranches: Array<{ value: string; label: string }> =
                  Array.isArray(step.config?.branches) ? step.config!.branches : [];
                const defs = condBranches.length > 0
                  ? condBranches
                  : [{ value: 'if', label: 'True' }, { value: 'if_not', label: 'False' }];

                return (
                  <div className="ml-2 mt-1 space-y-0.5 relative">
                    {defs.map((bd) => {
                      const labelColor =
                        bd.label === 'True' || bd.label === 'Completed'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : bd.label === 'False' || bd.label === 'Failed'
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-muted-foreground';

                      return (
                        <div key={bd.value} className="flex items-center gap-2 py-1.5 relative">
                          <GitBranch className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                          <span className={cn('text-[11px] font-medium', labelColor)}>{bd.label}</span>
                          {/* Connector dot */}
                          <div data-connector-id={`step:${step.id}:branch:${bd.value}`} className="absolute -right-[15px] top-1/2 -translate-y-1/2 w-[9px] h-[9px] rounded-full bg-white border border-blue-500 z-10" />
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
            </React.Fragment>
          ))}

          {/* Add step footer */}
          {lastStepIsTerminal ? (
            <div className="pt-1 flex items-center justify-center py-2 text-[10px] text-muted-foreground/50">
              {cn_.endOfPath}
            </div>
          ) : (
            <div className="pt-1">
              <Button
                type="button"
                variant="ghost"
                onClick={(e) => { e.stopPropagation(); onAddStep?.(lastStepId); }}
                className="flex items-center justify-center gap-1.5 w-full rounded-lg border border-dashed border-muted-foreground/30 py-2 text-xs font-medium text-muted-foreground hover:border-muted-foreground/50 hover:text-primary hover:bg-muted transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                {cn_.addStep}
              </Button>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
