"use client"

import * as React from 'react';
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Zap, Calendar, Webhook, MousePointerClick, GitMerge, Plus, Plug, Code } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { TriggerNodeData } from './flow-utils';
import { StepCard, STEP_HANDLE_CLASS } from './parts/step-card';
import type { TriggerConfig } from './types';

const triggerIcons: Record<string, React.ElementType> = {
  entity_event: Zap,
  integration_event: Plug,
  schedule: Calendar,
  workflow_complete: GitMerge,
  webhook: Webhook,
  manual: MousePointerClick,
  api: Code,
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
    integrationEvent?: string;
    apiTriggered?: string;
  };
}

function TriggerNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as TriggerNodeData & { labels?: TriggerNodeLabels };
  const labels = nodeData.labels || {};
  const triggerType = nodeData.trigger?.type || 'manual';
  const Icon = triggerIcons[triggerType] || Zap;
  const triggerBadge = labels.triggerBadge ?? 'Trigger';
  const addStepLabel = nodeData.addStepLabel ?? 'Add step';
  const [isHovered, setIsHovered] = useState(false);

  const desc = labels.descriptions;
  const clickToConfigure = desc?.clickToConfigure ?? 'Click to configure';

  const getDescription = () => {
    // Schedule/workflow triggers carry extra fields alongside the base config,
  // and older records keep them nested under `config` instead.
  const trigger = nodeData.trigger as TriggerConfig & {
    entityType?: string;
    eventType?: string;
    provider?: string;
    event?: string;
    scheduleType?: string;
    cronExpression?: string;
    executeAt?: string;
    triggerOn?: string;
    config?: {
      scheduleType?: string;
      cronExpression?: string;
      executeAt?: string;
      triggerOn?: string;
      entityType?: string;
      eventType?: string;
      provider?: string;
      event?: string;
    };
  };
    if (!trigger) return clickToConfigure;
    if (nodeData.label === 'Select Trigger') return clickToConfigure;
    if (trigger.summary) return trigger.summary;

    switch (trigger.type) {
      case 'entity_event':
        return nodeData.entityEvent || clickToConfigure;
      case 'integration_event': {
        const provider = trigger.provider || trigger.config?.provider;
        const event = trigger.event || trigger.config?.event;
        if (provider && event) return `${provider}: ${event}`;
        return desc?.integrationEvent ?? 'Connected app event';
      }
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
      case 'api':
        return desc?.apiTriggered ?? 'Triggered via API';
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
        <StepCard
          icon={Icon}
          title={nodeData.label}
          typeLabel={triggerBadge}
          summary={description}
          state={selected && !nodeData.locked ? 'selected' : 'default'}
        />

        {/* Output handle */}
        <Handle
          type="source"
          position={Position.Bottom}
          className={cn(STEP_HANDLE_CLASS, '!z-10 !invisible lg:!visible')}
          style={{ bottom: '1px' }}
        />
      </div>

      {/* Add step button under the last node - DESKTOP ONLY (mobile has its own below) */}
      {nodeData.isLastNode && !nodeData.showAddPlaceholder && (
        <>
          <div className="absolute left-1/2 -translate-x-1/2 bottom-8 w-px h-5 border-l border-dashed border-border hidden lg:block" />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); nodeData.onAddStep?.(nodeData.nodeId); }}
            className={cn(
              'absolute left-1/2 -translate-x-1/2 bottom-1.5 h-7 pl-1.5 pr-2.5 rounded-md hidden lg:flex items-center gap-1 whitespace-nowrap transition-colors',
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

      {/* Mobile-only add step button */}
      <div className="lg:hidden relative z-10 flex flex-col items-center -mt-[14px]">
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

export const TriggerNode = memo(TriggerNodeComponent);
