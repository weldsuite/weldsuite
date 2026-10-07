"use client"

import * as React from 'react';
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Mail,
  Globe,
  Clock,
  GitBranch,
  Repeat,
  Variable,
  Wand2,
  Plus,
  Building2,
  Pencil,
  Trash2,
  Search,
  Bell,
  Code,
  Sparkles,
  FileSearch,
  FileText,
  Box,
  UserPlus,
  Tag,
  CircleDot,
  ArrowUpCircle,
  Reply,
  StickyNote,
  Ticket,
  Shield,
  Star,
  MessageSquareText,
  ListChecks,
  ClipboardList,
  Bot,
  UserCheck,
  AlertCircle,
  Tags,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ActionNodeData } from './flow-utils';
import { asText } from '@weldsuite/text';

// Amber "Setup required" badge shown on nodes missing required configuration.
export function SetupRequiredBadge({ label }: Readonly<{ label?: string }>) {
  return (
    <div className="absolute -top-2.5 left-3 z-20 flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 shadow-sm dark:border-amber-800 dark:bg-amber-950">
      <AlertCircle className="h-3 w-3 text-amber-600 dark:text-amber-400" />
      <span className="whitespace-nowrap text-[10px] font-medium text-amber-700 dark:text-amber-300">
        {label || 'Setup required'}
      </span>
    </div>
  );
}

// Static fallback category labels (EN)
const ACTION_CATEGORY_LABELS_DEFAULT: Record<string, string> = {
  send_email: 'Email',
  http_request: 'Integrations',
  delay: 'Flow control',
  condition: 'Conditions',
  loop: 'Flow control',
  set_variable: 'Variables',
  transform_data: 'Data',
  create_record: 'Records',
  create_customer: 'CRM',
  update_record: 'Records',
  delete_record: 'Records',
  query_data: 'Records',
  send_notification: 'Notifications',
  run_script: 'Scripts',
  ai_generate: 'AI',
  ai_classify: 'AI',
  ai_extract: 'AI',
  ai_summarize: 'AI',
  assign_conversation: 'Conversations',
  tag_conversation: 'Conversations',
  change_conversation_status: 'Conversations',
  change_priority: 'Conversations',
  send_reply: 'Conversations',
  add_internal_note: 'Conversations',
  create_ticket_from_conversation: 'Tickets',
  apply_sla: 'SLA',
  trigger_csat: 'Satisfaction',
  send_message: 'Messages',
  send_choices: 'Messages',
  collect_input: 'Messages',
  ai_agent: 'Agents',
  manual_step: 'Approvals',
};

const actionIcons: Record<string, React.ElementType> = {
  send_email: Mail,
  http_request: Globe,
  delay: Clock,
  condition: GitBranch,
  loop: Repeat,
  set_variable: Variable,
  transform_data: Wand2,
  create_record: Plus,
  create_customer: Building2,
  update_record: Pencil,
  delete_record: Trash2,
  query_data: Search,
  send_notification: Bell,
  run_script: Code,
  ai_generate: Sparkles,
  ai_classify: Tags,
  ai_extract: FileSearch,
  ai_summarize: FileText,
  assign_conversation: UserPlus,
  tag_conversation: Tag,
  change_conversation_status: CircleDot,
  change_priority: ArrowUpCircle,
  send_reply: Reply,
  add_internal_note: StickyNote,
  create_ticket_from_conversation: Ticket,
  apply_sla: Shield,
  trigger_csat: Star,
  send_message: MessageSquareText,
  send_choices: ListChecks,
  collect_input: ClipboardList,
  ai_agent: Bot,
  manual_step: UserCheck,
};

// Extended node data including i18n labels injected via workflowToFlow
interface ActionNodeDataExtended extends ActionNodeData {
  labels?: {
    categoryLabels?: Record<string, string>;
    noDescription?: string;
    defaultCategory?: string;
    subAgent?: string;
    descTo?: string;
    descDelay?: string;
    descEntity?: string;
  };
}

type ActionNodeLabels = NonNullable<ActionNodeDataExtended['labels']>;
type ActionConfig = Record<string, unknown>;

const DELAY_UNITS = ['days', 'hours', 'minutes', 'seconds'] as const;

function describeDelay(config: ActionConfig, labels: ActionNodeLabels): string | null {
  const unit = DELAY_UNITS.find((u) => config[u]);
  if (!unit) return null;
  return (labels.descDelay || 'Wait {duration} {unit}')
    .replace('{duration}', asText(config[unit]))
    .replace('{unit}', unit);
}

function describeEntityAction(config: ActionConfig, labels: ActionNodeLabels): string | null {
  const entity = config.entityType || config.entity;
  if (!entity) return null;
  return (labels.descEntity || '{entityType}').replace('{entityType}', asText(entity));
}

// Type-specific one-line summaries; each returns null when its config lacks the needed field.
const ACTION_DESCRIBERS: Record<string, (config: ActionConfig, labels: ActionNodeLabels) => string | null> = {
  send_email: (config, labels) =>
    config.to ? (labels.descTo || 'To: {to}').replace('{to}', asText(config.to)) : null,
  http_request: (config) =>
    config.url ? `${asText(config.method ?? 'GET')} ${asText(config.url)}` : null,
  delay: describeDelay,
  create_customer: (config) =>
    typeof config.name === 'string' && config.name ? config.name : null,
  create_record: describeEntityAction,
  update_record: describeEntityAction,
  delete_record: describeEntityAction,
  query_data: describeEntityAction,
};

function getActionDescription(nodeData: ActionNodeDataExtended, labels: ActionNodeLabels): string {
  const fallback = labels.noDescription || 'Not configured';
  if (nodeData.step?.description) return nodeData.step.description;
  const config = nodeData.step?.config as ActionConfig | undefined;
  if (!config || Object.keys(config).length === 0) return fallback;
  if (typeof config.description === 'string') return config.description;
  const describe = Object.prototype.hasOwnProperty.call(ACTION_DESCRIBERS, nodeData.actionType)
    ? ACTION_DESCRIBERS[nodeData.actionType]
    : undefined;
  return describe?.(config, labels) ?? fallback;
}

function ActionNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as ActionNodeDataExtended;
  const labels = nodeData.labels || {};
  const actionCategoryLabels = labels.categoryLabels || ACTION_CATEGORY_LABELS_DEFAULT;

  const Icon = actionIcons[nodeData.actionType] || Box;
  const [isHovered, setIsHovered] = useState(false);
  const needsConfig = !nodeData.isConfigured;
  const addStepLabel = nodeData.addStepLabel ?? 'Add step';

  const categoryLabel = actionCategoryLabels[nodeData.actionType] || labels.defaultCategory || 'Action';
  const description = getActionDescription(nodeData, labels);

  return (
    <div
      className={cn('relative cursor-pointer', nodeData.isLastNode && 'pb-12 -mb-12')}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="relative">
        {needsConfig && <SetupRequiredBadge label={nodeData.setupRequiredLabel} />}
        <Handle type="target" position={Position.Top} className="!bg-transparent !border-0" style={{ top: 0, width: 0, height: 0, minWidth: 0, minHeight: 0 }} />
        <div
          className={cn(
            'bg-white dark:bg-background rounded-xl w-[340px] border transition-all',
            selected
              ? 'border-blue-400'
              : needsConfig
                ? 'border-amber-300 dark:border-amber-700'
                : 'border-border hover:border-foreground/20'
          )}
          onClick={() => nodeData.onSelect?.()}
        >
          <div className="px-4 py-3">
            <div className="flex items-center justify-between min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-5 h-5 rounded-[6px] bg-muted flex items-center justify-center flex-shrink-0">
                  <Icon className="w-3 h-3 text-muted-foreground" />
                </div>
                <span className="text-sm font-medium text-foreground truncate">{nodeData.label}</span>
              </div>
              <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-3 flex-shrink-0">
                {categoryLabel}
              </span>
            </div>
          </div>
          {description && (
            <div className="px-4 pb-3 pt-0">
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground truncate">{description}</p>
              </div>
            </div>
          )}
        </div>

        {nodeData.actionType === 'ai_agent' && (
          <div className="absolute top-1/2 -translate-y-1/2 left-full hidden lg:flex items-center">
            <div className="w-5 border-t border-dashed border-border" />
            <button
              onClick={(e) => { e.stopPropagation(); nodeData.onAddSubAgent?.(nodeData.step.id); }}
              className="h-7 px-2.5 rounded-lg border border-dashed border-border bg-white dark:bg-background hover:border-foreground/30 hover:bg-accent flex items-center gap-1.5 transition-colors"
            >
              <Plus className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap">{labels.subAgent || 'Sub-Agent'}</span>
            </button>
          </div>
        )}

        <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-white dark:!bg-background !border-[1.5px] !border-blue-400 !z-10 !hidden lg:!block" style={{ bottom: '1px' }} />

        {nodeData.actionType === 'ai_agent' && (
          <Handle type="source" position={Position.Right} id="subagents" className="!w-2.5 !h-2.5 !bg-white dark:!bg-background !border-[1.5px] !border-border !right-0" />
        )}
      </div>

      {nodeData.isLastNode && !nodeData.showAddPlaceholder && (
        <>
          <div className="absolute left-1/2 -translate-x-1/2 bottom-8 w-px h-5 border-l border-dashed border-border hidden lg:block" />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); nodeData.onAddStep?.(nodeData.nodeId); }}
            className={cn(
              'absolute left-1/2 -translate-x-1/2 bottom-2.5 h-6 pl-1.5 pr-2.5 rounded-full hidden lg:flex items-center gap-1 whitespace-nowrap transition-colors',
              'text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isHovered
                ? 'bg-foreground text-background'
                : 'bg-background text-muted-foreground border border-border hover:text-foreground',
            )}
          >
            <Plus className="w-3 h-3" />
            {addStepLabel}
          </button>
        </>
      )}

      <div className="lg:hidden flex flex-col items-center -mt-[14px]">
        <button
          type="button"
          aria-label={addStepLabel}
          title={addStepLabel}
          onClick={(e) => { e.stopPropagation(); nodeData.onAddStep?.(nodeData.nodeId); }}
          className="w-7 h-7 rounded-full bg-foreground/80 hover:bg-foreground active:bg-foreground flex items-center justify-center transition-all"
        >
          <Plus className="w-3.5 h-3.5 text-background" />
        </button>
      </div>
    </div>
  );
}

export const ActionNode = memo(ActionNodeComponent);

// Placeholder Node - Shows where new step will be added
function PlaceholderNodeComponent(_props: NodeProps) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-0" style={{ top: 0, width: 0, height: 0, minWidth: 0, minHeight: 0 }} />
      <div className="bg-white dark:bg-background rounded-xl w-[340px] border border-dashed border-border flex items-center justify-center py-8">
        <Plus className="w-5 h-5 text-muted-foreground/50" />
      </div>
    </div>
  );
}

export const PlaceholderNode = memo(PlaceholderNodeComponent);
