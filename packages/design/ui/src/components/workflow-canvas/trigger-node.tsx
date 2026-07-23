"use client"

import * as React from 'react';
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Zap, Calendar, Webhook, MousePointerClick, GitMerge, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { TriggerNodeData } from './flow-utils';

const triggerIcons: Record<string, React.ElementType> = {
  entity_event: Zap,
  schedule: Calendar,
  workflow_complete: GitMerge,
  webhook: Webhook,
  manual: MousePointerClick,
};

// Labels injected via node data (passed through workflowToFlow options.labels)
interface TriggerNodeLabels {
  triggerBadge?: string;
  categories?: Record<string, string>;
  descriptions?: {
    clickToConfigure?: string;
    recurringSchedule?: string;
    scheduled?: string;
    onCompletion?: string;
    httpEndpoint?: string;
    manuallyTriggered?: string;
    sequenceAdded?: string;
  };
}

function TriggerNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as TriggerNodeData & { labels?: TriggerNodeLabels };
  const labels = nodeData.labels || {};
  const triggerType = nodeData.trigger?.type || 'manual';
  const Icon = triggerIcons[triggerType] || Zap;
  const triggerBadge = labels.triggerBadge ?? 'Trigger';
  const category = labels.categories?.[triggerType] ?? triggerBadge;
  const [isHovered, setIsHovered] = useState(false);

  const desc = labels.descriptions;
  const clickToConfigure = desc?.clickToConfigure ?? 'Click to configure';

  const getDescription = () => {
    const trigger = nodeData.trigger as any;
    if (!trigger) return clickToConfigure;
    if (nodeData.label === 'Select Trigger') return clickToConfigure;

    switch (trigger.type) {
      case 'entity_event':
        return nodeData.entityEvent || clickToConfigure;
      case 'schedule': {
        const scheduleType = trigger.scheduleType || trigger.config?.scheduleType;
        const cronExpression = trigger.cronExpression || trigger.config?.cronExpression;
        const executeAt = trigger.executeAt || trigger.config?.executeAt;
        if (scheduleType === 'recurring') return cronExpression || (desc?.recurringSchedule ?? 'Recurring schedule');
        if (scheduleType === 'one_time' && executeAt) return new Date(executeAt).toLocaleString();
        if (scheduleType || cronExpression || executeAt) return cronExpression || (desc?.scheduled ?? 'Scheduled');
        return clickToConfigure;
      }
      case 'workflow_complete': {
        const triggerOn = trigger.triggerOn || trigger.config?.triggerOn;
        const template = desc?.onCompletion ?? 'On {triggerOn}';
        return template.replace('{triggerOn}', triggerOn || 'completion');
      }
      case 'webhook':
        return desc?.httpEndpoint ?? 'HTTP endpoint';
      case 'manual':
        return desc?.manuallyTriggered ?? 'Manually triggered';
      default:
        return clickToConfigure;
    }
  };

  const description = nodeData.locked
    ? (desc?.sequenceAdded ?? 'Contact added to sequence')
    : getDescription();

  return (
    <div
      className={cn("relative", nodeData.locked ? "cursor-default" : "cursor-pointer", nodeData.isLastNode && "pb-12 -mb-12")}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Main card */}
      <div className="relative">
        <div
          className={cn(
            'bg-white dark:bg-background rounded-xl w-[340px] border transition-all',
            selected && !nodeData.locked
              ? 'border-blue-400 '
              : 'border-border hover:border-foreground/20 hover:'
          )}
        >
          <div className="px-4 py-3">
            <div className="flex items-center justify-between min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-5 h-5 rounded-[6px] bg-muted flex items-center justify-center flex-shrink-0">
                  <Icon className="w-3 h-3 text-muted-foreground" />
                </div>
                <span className="text-sm font-medium text-foreground truncate">
                  {nodeData.label}
                </span>
              </div>
              <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-3 flex-shrink-0">
                {triggerBadge}
              </span>
            </div>
          </div>
          {description && (
            <div className="px-4 pb-3 pt-0">
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground truncate">
                  {description}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Output handle */}
        <Handle
          type="source"
          position={Position.Bottom}
          className="!w-3 !h-3 !bg-white dark:!bg-background !border-[1.5px] !border-blue-400 !z-10 !hidden lg:!block"
          style={{ bottom: '1px' }}
        />
      </div>

      {/* Add step button - shows on hover for last node - DESKTOP ONLY */}
      {nodeData.isLastNode && isHovered && !nodeData.showAddPlaceholder && (
        <>
          <div className="absolute left-1/2 -translate-x-1/2 bottom-8 w-px h-5 border-l border-dashed border-border hidden lg:block" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              nodeData.onAddStep?.(nodeData.nodeId);
            }}
            className="absolute left-1/2 -translate-x-1/2 bottom-3 w-5 h-5 rounded-full bg-foreground/80 hover:bg-foreground hidden lg:flex items-center justify-center transition-all"
          >
            <Plus className="w-3 h-3 text-background" />
          </button>
        </>
      )}

      {/* Mobile-only add step button */}
      <div className="lg:hidden flex flex-col items-center -mt-[14px]">
        <button
          onClick={(e) => {
            e.stopPropagation();
            nodeData.onAddStep?.(nodeData.nodeId);
          }}
          className="w-7 h-7 rounded-full bg-foreground/80 hover:bg-foreground active:bg-foreground flex items-center justify-center transition-all"
        >
          <Plus className="w-3.5 h-3.5 text-background" />
        </button>
      </div>
    </div>
  );
}

export const TriggerNode = memo(TriggerNodeComponent);
