import React, { useState, useRef, useMemo, useLayoutEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  derivePaths,
  computeLayout,
  type WorkflowStep,
  type WorkflowTrigger,
  type CanvasEdge,
  type LayoutResult,
} from './canvas-utils';
import { TriggerNode, PathNode } from './canvas-nodes';

// ============================================================================
// Types
// ============================================================================

export interface ConversationFlowBuilderProps {
  trigger: WorkflowTrigger | null;
  steps: WorkflowStep[];
  onSelectTrigger: () => void;
  onSelectStep: (index: number) => void;
  onSelectBranch: (branchNodeId: string, branchType: string, parentConditionId: string, parentConditionStepIndex: number) => void;
  onDeleteStep: (index: number) => void;
  onStepsChange: (steps: WorkflowStep[]) => void;
  onAddStep: (sourceNodeId?: string) => void;
  onAddActionInline?: (actionType: string, sourceNodeId?: string) => void;
  onUpdateConfig: (stepId: string, config: Record<string, any>) => void;
  onAddSubAgent?: (stepId: string) => void;
  onEditSubAgent?: (subAgentId: string) => void;
  onDeselect: () => void;
  selectedNodeId: string | null;
  showAddPlaceholder?: boolean;
  addStepSourceNodeId?: string | null;
  variableItems?: any[];
  className?: string;
}

// ============================================================================
// SVG Edge rendering
// ============================================================================

function EdgePath({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  const midX = from.x + (to.x - from.x) / 2;
  const r = Math.min(20, Math.abs(to.y - from.y) / 2, Math.abs(to.x - from.x) / 4);
  const dy = to.y - from.y;

  let d: string;
  if (Math.abs(dy) < 2) {
    d = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  } else {
    const sy = dy > 0 ? 1 : -1;
    d = [
      `M ${from.x} ${from.y}`,
      `L ${midX - r} ${from.y}`,
      `Q ${midX} ${from.y} ${midX} ${from.y + sy * r}`,
      `L ${midX} ${to.y - sy * r}`,
      `Q ${midX} ${to.y} ${midX + r} ${to.y}`,
      `L ${to.x} ${to.y}`,
    ].join(' ');
  }
  return <path d={d} stroke="currentColor" strokeWidth={1.5} fill="none" className="text-gray-300" />;
}

function measureConnectors(container: HTMLElement): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  const containerRect = container.getBoundingClientRect();
  const dots = container.querySelectorAll<HTMLElement>('[data-connector-id]');
  dots.forEach((dot) => {
    const id = dot.dataset.connectorId;
    if (!id) return;
    const rect = dot.getBoundingClientRect();
    map.set(id, {
      x: rect.left + rect.width / 2 - containerRect.left,
      y: rect.top + rect.height / 2 - containerRect.top,
    });
  });
  return map;
}

function CanvasEdges({
  edges,
  connectors,
  width,
  height,
}: {
  edges: CanvasEdge[];
  connectors: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}) {
  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      width={width}
      height={height}
      style={{ overflow: 'visible' }}
    >
      {edges.map((edge) => {
        const from = connectors.get(edge.fromKey);
        const to = connectors.get(edge.toKey);
        if (!from || !to) return null;
        return <EdgePath key={edge.id} from={from} to={to} />;
      })}
    </svg>
  );
}

// ============================================================================
// Main Component — Simplified (no zoom/pan, scrollable)
// ============================================================================

export function ConversationFlowBuilder({
  trigger,
  steps,
  onSelectTrigger,
  onSelectStep,
  onSelectBranch,
  onDeleteStep,
  onStepsChange,
  onAddStep,
  onAddActionInline,
  onUpdateConfig,
  onAddSubAgent,
  onEditSubAgent,
  onDeselect,
  selectedNodeId,
  className,
}: ConversationFlowBuilderProps) {
  const canvasLayerRef = useRef<HTMLDivElement>(null);

  // Derived layout
  const { paths, edges } = useMemo(() => derivePaths(steps, trigger), [steps, trigger]);
  const layout = useMemo(() => computeLayout(paths, trigger), [paths, trigger]);

  // Measure connector dot positions from DOM after render
  const [connectors, setConnectors] = useState<Map<string, { x: number; y: number }>>(new Map());
  const prevLayoutKey = useRef('');

  useLayoutEffect(() => {
    const el = canvasLayerRef.current;
    if (!el) return;
    const key = JSON.stringify({ t: layout.trigger, p: layout.paths, s: steps.length });
    if (key === prevLayoutKey.current) return;
    prevLayoutKey.current = key;
    const measured = measureConnectors(el);
    setConnectors(measured);
  });

  const handleBgClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvasBg) {
      onDeselect();
    }
  };

  return (
    <div
      className={cn(
        'relative w-full h-full overflow-auto',
        className,
      )}
      style={{
        backgroundColor: 'color-mix(in srgb, var(--color-muted) 30%, transparent)',
      }}
      onClick={handleBgClick}
    >
      <div
        ref={canvasLayerRef}
        data-canvas-bg="true"
        style={{
          position: 'relative',
          minWidth: layout.canvasWidth,
          minHeight: layout.canvasHeight,
          padding: '40px',
        }}
      >
        {/* SVG edges */}
        <CanvasEdges
          edges={edges}
          connectors={connectors}
          width={layout.canvasWidth}
          height={layout.canvasHeight}
        />

        {/* Trigger node */}
        <TriggerNode
          trigger={trigger}
          isSelected={selectedNodeId === 'trigger'}
          onClick={onSelectTrigger}
          style={{
            position: 'absolute',
            left: layout.trigger.x,
            top: layout.trigger.y,
          }}
        />

        {/* Path nodes */}
        {paths.map((path, i) => {
          const pos = layout.paths.find((p) => p.id === path.id);
          if (!pos) return null;
          return (
            <PathNode
              key={path.id}
              path={path}
              pathIndex={i}
              allSteps={steps}
              selectedNodeId={selectedNodeId}
              onSelectStep={onSelectStep}
              onSelectBranch={onSelectBranch}
              onAddActionInline={onAddActionInline}
              onAddStep={onAddStep}
              onUpdateConfig={onUpdateConfig}
              onReorderSteps={onStepsChange}
              trigger={trigger}
              style={{
                position: 'absolute',
                left: pos.x,
                top: pos.y,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
