"use client"

import * as React from 'react';
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Bot, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { SubAgentNodeData } from './flow-utils';

interface SubAgentNodeDataExtended extends SubAgentNodeData {
  agentLabel?: string;
}

function SubAgentNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as SubAgentNodeDataExtended;
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className="relative cursor-pointer"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => nodeData.onEditSubAgent?.(nodeData.subAgentId)}
    >
      {/* Left-side target handle */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-white dark:!bg-background !border-[1.5px] !border-border !left-0"
      />

      {/* Compact card */}
      <div
        className={cn(
          'bg-white dark:bg-background rounded-xl w-[220px] border transition-all',
          selected
            ? 'border-blue-400 '
            : 'border-border hover:border-foreground/20 hover:'
        )}
      >
        <div className="px-3 py-2.5">
          <div className="flex items-center justify-between min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-5 h-5 rounded-[6px] bg-muted flex items-center justify-center flex-shrink-0">
                <Bot className="w-3 h-3 text-muted-foreground" />
              </div>
              <span className="text-sm font-medium text-foreground truncate flex-1">
                {nodeData.subAgentName}
              </span>
            </div>
            <span className="text-[11px] font-medium text-muted-foreground/70 ml-2 flex-shrink-0">
              {nodeData.agentLabel || 'Agent'}
            </span>
          </div>
        </div>
      </div>

      {/* Remove button — visible on hover */}
      {isHovered && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            nodeData.onRemove?.();
          }}
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-foreground/80 hover:bg-foreground flex items-center justify-center transition-colors"
        >
          <X className="w-3 h-3 text-background" />
        </button>
      )}
    </div>
  );
}

export const SubAgentNode = memo(SubAgentNodeComponent);
