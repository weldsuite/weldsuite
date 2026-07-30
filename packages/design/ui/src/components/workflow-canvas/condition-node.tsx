"use client"

import * as React from 'react';
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GitBranch, CheckCircle2, X, Plus, ArrowUpRight, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { SetupRequiredBadge } from './action-node';
import type { ConditionNodeData, ConditionBranchNodeData } from './flow-utils';

// Static operator symbols (language-neutral)
const OPERATOR_SYMBOLS: Record<string, string> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

interface ConditionNodeLabels {
  label?: string;
  checkAgentStatus?: string;
  clickToConfigure?: string;
  operators?: Record<string, string>;
  branchLabels?: Record<string, string>;
}

/** Shorten the `{{steps.…}}` / `{{trigger.data.…}}` prefixes for display. */
function shortenFieldPath(field: string): string {
  return field
    .replace(/\{\{steps\.[^.]+\./, '{{agent.')
    .replace(/\{\{trigger\.data\./, '{{');
}

function getConditionSummary(config: Record<string, unknown>, operatorLabels: Record<string, string>): string | null {
  const field = typeof config?.field === 'string' ? config.field : '';
  if (!field) return null;
  const operator = typeof config.operator === 'string' ? config.operator : '';
  const op = OPERATOR_SYMBOLS[operator] ?? operatorLabels[operator] ?? operator ?? '=';
  const value = config.value;
  const shortField = shortenFieldPath(field);
  if (['isEmpty', 'isNotEmpty'].includes(operator)) {
    return `${shortField} ${op}`;
  }
  return `${shortField} ${op} ${value || '?'}`;
}

function ConditionNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as ConditionNodeData & { labels?: ConditionNodeLabels };
  const labels = nodeData.labels || {};
  const operatorLabels = (labels.operators || {}) as Record<string, string>;

  const config = (nodeData.step?.config || {}) as Record<string, unknown>;
  const hasMultiBranch = config.branches && Array.isArray(config.branches);
  const summary = getConditionSummary(config, operatorLabels);
  const conditionLabel = labels.label || 'Condition';
  const needsConfig = !nodeData.isConfigured;

  // Display-only summary text — editing happens in the side panel.
  let bodyText: string;
  if (hasMultiBranch) {
    bodyText = typeof config.field === 'string' && config.field
      ? shortenFieldPath(config.field)
      : (labels.checkAgentStatus || 'Check agent status');
  } else if (summary) {
    bodyText = summary;
  } else {
    bodyText = labels.clickToConfigure || 'Click to configure';
  }

  return (
    <div
      className="relative cursor-pointer"
      onClick={() => nodeData.onSelect?.()}
    >
      <div className="relative">
        {needsConfig && <SetupRequiredBadge label={nodeData.setupRequiredLabel} />}
        <Handle type="target" position={Position.Top} className="!bg-transparent !border-0" style={{ top: 0, width: 0, height: 0, minWidth: 0, minHeight: 0 }} />
        <div
          className={cn(
            'bg-white dark:bg-background rounded-xl w-[340px] border transition-all',
            selected
              ? 'border-blue-400 '
              : needsConfig
                ? 'border-amber-300 dark:border-amber-700'
                : 'border-border hover:border-foreground/20 hover:'
          )}
        >
          <div className="px-4 py-3">
            <div className="flex items-center justify-between min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-5 h-5 rounded-[6px] bg-muted flex items-center justify-center flex-shrink-0">
                  <GitBranch className="w-3 h-3 text-muted-foreground" />
                </div>
                <span className="text-sm font-medium text-foreground truncate">
                  {nodeData.label || conditionLabel}
                </span>
              </div>
              <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-3 flex-shrink-0">
                {conditionLabel}
              </span>
            </div>
          </div>

          <div className="px-4 pb-3 pt-0">
            <div className="border-t border-border pt-3">
              <p className="text-xs text-muted-foreground font-mono truncate">{bodyText}</p>
            </div>
          </div>
        </div>

        <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-white dark:!bg-background !border-[1.5px] !border-blue-400" style={{ bottom: '1px' }} />
      </div>
    </div>
  );
}

export const ConditionNode = memo(ConditionNodeComponent);

// Branch icons
const BRANCH_ICONS: Record<string, typeof CheckCircle2> = {
  if: CheckCircle2,
  if_not: X,
  escalated: ArrowUpRight,
  completed: CheckCircle2,
  failed: XCircle,
};

function ConditionBranchNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as ConditionBranchNodeData & { branchLabels?: Record<string, string> };
  const branchLabels = nodeData.branchLabels || {};
  const [isHovered, setIsHovered] = useState(false);
  const BranchIcon = BRANCH_ICONS[nodeData.branchType] || GitBranch;
  const floatingLabel = branchLabels[nodeData.branchType] || nodeData.label;

  return (
    <div
      className={cn("relative cursor-pointer", nodeData.isLastNode && "pb-12 -mb-12")}
      onClick={() => nodeData.onSelectBranch?.(nodeData.nodeId, nodeData.branchType, nodeData.parentConditionId, nodeData.parentConditionStepIndex)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="relative">
        <Handle type="target" position={Position.Top} className="!bg-transparent !border-0" style={{ top: 0, width: 0, height: 0, minWidth: 0, minHeight: 0 }} />

        <div
          className={cn(
            'bg-white dark:bg-background rounded-xl w-[340px] border transition-all',
            selected ? 'border-blue-400 ' : 'border-border hover:border-foreground/20 hover:'
          )}
        >
          <div className="px-4 py-3">
            <div className="flex items-center justify-between min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-5 h-5 rounded-[6px] bg-muted flex items-center justify-center flex-shrink-0">
                  <BranchIcon className="w-3 h-3 text-muted-foreground" />
                </div>
                <span className="text-sm font-medium text-foreground truncate">{nodeData.label}</span>
              </div>
              <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-3 flex-shrink-0">
                {floatingLabel}
              </span>
            </div>
          </div>
          {nodeData.conditionLabel && (
            <div className="px-4 pb-3 pt-0">
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground truncate">{nodeData.conditionLabel}</p>
              </div>
            </div>
          )}
        </div>

        <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-white dark:!bg-background !border-[1.5px] !border-blue-400 !z-10 !hidden lg:!block" style={{ bottom: '1px' }} />
      </div>

      {nodeData.isLastNode && isHovered && (
        <>
          <div className="absolute left-1/2 -translate-x-1/2 bottom-8 w-px h-5 border-l border-dashed border-border hidden lg:block" />
          <button
            onClick={(e) => { e.stopPropagation(); nodeData.onAddStep?.(nodeData.nodeId); }}
            className="absolute left-1/2 -translate-x-1/2 bottom-3 w-5 h-5 rounded-full bg-foreground/80 hover:bg-foreground hidden lg:flex items-center justify-center transition-all"
          >
            <Plus className="w-3 h-3 text-background" />
          </button>
        </>
      )}

      {nodeData.isLastNode && (
        <div className="lg:hidden flex flex-col items-center -mt-[14px]">
          <button
            onClick={(e) => { e.stopPropagation(); nodeData.onAddStep?.(nodeData.nodeId); }}
            className="w-7 h-7 rounded-full bg-foreground/80 hover:bg-foreground active:bg-foreground flex items-center justify-center transition-all"
          >
            <Plus className="w-3.5 h-3.5 text-background" />
          </button>
        </div>
      )}
    </div>
  );
}

export const ConditionBranchNode = memo(ConditionBranchNodeComponent);
