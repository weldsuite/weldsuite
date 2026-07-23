"use client"

import * as React from 'react';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type IsValidConnection,
  BackgroundVariant,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { TriggerNode } from './trigger-node';
import { ActionNode, PlaceholderNode } from './action-node';
import { ConditionNode, ConditionBranchNode } from './condition-node';
import { SubAgentNode } from './sub-agent-node';
import { workflowToFlow, autoLayoutNodes, getNodeHeight, getTotalNodeHeight } from './flow-utils';
import type { WorkflowStep, TriggerConfig, WorkflowCanvasLabels, VariableItem } from './types';
import { DEFAULT_CANVAS_LABELS } from './types';
import { Plus, Minus, Maximize } from 'lucide-react';

// Alignment threshold in pixels
const ALIGNMENT_THRESHOLD = 8;

const getNodeWidth = (_node: Node) => {
  // All nodes share one uniform width.
  return 340;
};

const getNodeLeftX = (node: Node) => node.position.x;
const getNodeRightX = (node: Node) => node.position.x + getNodeWidth(node);
const getNodeCenterX = (node: Node) => node.position.x + getNodeWidth(node) / 2;

// Register custom node types
const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
  condition: ConditionNode,
  condition_branch: ConditionBranchNode,
  placeholder: PlaceholderNode,
  sub_agent: SubAgentNode,
};

// Alignment guide type with Y range
interface AlignmentGuide {
  x: number;
  type: 'center' | 'left' | 'right';
  yStart: number;
  yEnd: number;
}

// Custom controls component with Lucide icons
function CustomControls({ onResetLayout, labels }: { onResetLayout?: () => void; labels: Required<WorkflowCanvasLabels> }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <Panel position="bottom-right" className="!m-4">
      <div className="flex flex-col bg-white dark:bg-background border border-border rounded-lg overflow-hidden">
        <button
          onClick={() => zoomIn({ duration: 150 })}
          className="w-9 h-9 flex items-center justify-center hover:bg-muted transition-colors"
          title={labels.zoomIn}
        >
          <Plus className="w-4 h-4 text-foreground" />
        </button>
        <div className="border-t border-border" />
        <button
          onClick={() => zoomOut({ duration: 150 })}
          className="w-9 h-9 flex items-center justify-center hover:bg-muted transition-colors"
          title={labels.zoomOut}
        >
          <Minus className="w-4 h-4 text-foreground" />
        </button>
        <div className="border-t border-border" />
        <button
          onClick={() => {
            onResetLayout?.();
            setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
          }}
          className="w-9 h-9 flex items-center justify-center hover:bg-muted transition-colors"
          title={labels.resetLayout}
        >
          <Maximize className="w-4 h-4 text-foreground" />
        </button>
      </div>
    </Panel>
  );
}

// Alignment guides overlay
function AlignmentGuidesOverlay({ guides }: { guides: AlignmentGuide[] }) {
  const { getViewport } = useReactFlow();

  if (guides.length === 0) return null;

  const { x, y, zoom } = getViewport();

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <g transform={`translate(${x}, ${y}) scale(${zoom})`}>
        {guides.map((guide, index) => (
          <line
            key={`${guide.type}-${index}`}
            x1={guide.x}
            y1={guide.yStart}
            x2={guide.x}
            y2={guide.yEnd}
            stroke="var(--color-border)"
            strokeWidth={1.5 / zoom}
            strokeDasharray={`${6 / zoom} ${4 / zoom}`}
          />
        ))}
      </g>
    </svg>
  );
}

export interface WorkflowCanvasProps {
  trigger: TriggerConfig | null;
  steps: WorkflowStep[];
  onSelectTrigger: () => void;
  onSelectStep: (index: number) => void;
  onSelectBranch?: (branchNodeId: string, branchType: string, parentConditionId: string, parentConditionStepIndex: number) => void;
  onDeleteStep: (index: number) => void;
  onStepsChange: (steps: WorkflowStep[]) => void;
  onAddStep?: (sourceNodeId?: string) => void;
  onUpdateConfig?: (stepId: string, config: Record<string, any>) => void;
  onAddSubAgent?: (stepId: string) => void;
  onEditSubAgent?: (subAgentId: string) => void;
  onDeselect?: () => void;
  selectedNodeId?: string | null;
  showAddPlaceholder?: boolean;
  addStepSourceNodeId?: string | null;
  triggerLocked?: boolean;
  variableItems?: VariableItem[];
  /**
   * Optional i18n strings. Provide your app's translated strings here;
   * English defaults are used for any key you omit.
   */
  labels?: WorkflowCanvasLabels;
  /**
   * Called instead of `sonner.toast(...)` so the package stays toast-agnostic.
   * Wire to your preferred toast library in the host app.
   */
  onNotify?: (level: 'success' | 'error' | 'info', message: string) => void;
  className?: string;
}

function WorkflowCanvasInner({
  trigger,
  steps,
  onSelectTrigger,
  onSelectStep,
  onSelectBranch,
  onDeleteStep,
  onStepsChange,
  onAddStep,
  onUpdateConfig,
  onAddSubAgent,
  onEditSubAgent,
  onDeselect,
  selectedNodeId,
  showAddPlaceholder,
  addStepSourceNodeId,
  triggerLocked,
  variableItems,
  labels: labelsProp,
  onNotify,
  className,
}: WorkflowCanvasProps) {
  // Merge caller-provided labels with English defaults
  const labels: Required<WorkflowCanvasLabels> = {
    ...DEFAULT_CANVAS_LABELS,
    ...labelsProp,
    triggerLabels: { ...DEFAULT_CANVAS_LABELS.triggerLabels, ...(labelsProp?.triggerLabels || {}) },
    actionLabels: { ...DEFAULT_CANVAS_LABELS.actionLabels, ...(labelsProp?.actionLabels || {}) },
  };

  const flowLabels = {
    selectTrigger: labels.selectTrigger,
    triggerLabels: labels.triggerLabels,
    actionLabels: labels.actionLabels,
    setupRequired: labels.setupRequired,
  };

  const { zoomIn, zoomOut, getNodes, setCenter, getViewport } = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const prevStepNodeIdsRef = useRef<Set<string>>(new Set());
  const isFirstSyncRef = useRef(true);

  // Handle keyboard shortcuts for zoom
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          zoomIn({ duration: 150 });
        } else if (e.key === '-') {
          e.preventDefault();
          zoomOut({ duration: 150 });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [zoomIn, zoomOut]);

  // Convert workflow data to flow format
  const initialFlow = useMemo(() => {
    const { nodes, edges } = workflowToFlow(trigger, steps, {
      onSelectTrigger,
      onSelectStep,
      onSelectBranch,
      onDeleteStep,
      onAddStep,
      onUpdateConfig,
    }, { triggerLocked, variableItems, onAddSubAgent, onEditSubAgent, labels: flowLabels });

    const needsLayout = nodes.some(
      (n) => n.type !== 'trigger' && (!n.position || (n.position.x === 0 && n.position.y === 0))
    );

    if (needsLayout) {
      return { nodes: autoLayoutNodes(nodes, edges), edges };
    }

    return { nodes, edges };
  }, [trigger, steps, onSelectTrigger, onSelectStep, onSelectBranch, onDeleteStep, onAddStep, onUpdateConfig, onAddSubAgent, onEditSubAgent, triggerLocked]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlow.edges);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);

  // Sync nodes when steps change externally
  useEffect(() => {
    const { nodes: newNodes, edges: newEdges } = workflowToFlow(trigger, steps, {
      onSelectTrigger,
      onSelectStep,
      onSelectBranch,
      onDeleteStep,
      onAddStep,
      onUpdateConfig,
    }, { triggerLocked, variableItems, onAddSubAgent, onEditSubAgent, labels: flowLabels });

    const currentNodes = getNodes();

    const newStepNodes = newNodes.filter(n => n.type !== 'trigger' && n.type !== 'condition_branch' && n.type !== 'sub_agent');
    const hasAnyExistingStep = newStepNodes.some(n => currentNodes.find(existing => existing.id === n.id));
    const isBulkReplacement = newStepNodes.length > 0 && !hasAnyExistingStep;

    if (isBulkReplacement) {
      setNodes(newNodes.map(n => ({
        ...n,
        selected: n.id === selectedNodeId || (n.id === 'trigger' && selectedNodeId === 'trigger'),
      })));
      setEdges(newEdges);
      return;
    }

    const positionedNodes = newNodes.map((newNode, index) => {
      const existingNode = currentNodes.find((n) => n.id === newNode.id);
      const isSelected = newNode.id === selectedNodeId || (newNode.id === 'trigger' && selectedNodeId === 'trigger');

      if (existingNode) {
        return { ...newNode, position: existingNode.position, selected: isSelected };
      }

      const newNodeData = newNode.data as any;
      const hasParentBranch = newNodeData?.step?.parentBranchId;

      if (hasParentBranch && newNode.position && newNode.position.x !== 0) {
        return { ...newNode, selected: isSelected };
      }

      if (newNode.type !== 'trigger' && newNode.type !== 'condition_branch' && index > 0) {
        let prevNode: Node | undefined;
        let prevStepType = '';
        for (let i = index - 1; i >= 0; i--) {
          const candidate = newNodes[i];
          if (candidate.type === 'condition_branch') continue;
          const existing = currentNodes.find((n) => n.id === candidate.id);
          if (existing) {
            prevNode = existing;
            const pData = existing.data as any;
            prevStepType = pData?.actionType || pData?.step?.type || '';
            break;
          }
        }

        if (prevNode) {
          const prevNodeHeight = getTotalNodeHeight(prevStepType);
          const NODE_GAP_Y = 100;
          const prevNodeWidth = 340;
          const newNodeWidth = 340;
          const prevCenterX = prevNode.position.x + prevNodeWidth / 2;
          const newNodeX = prevCenterX - newNodeWidth / 2;

          return {
            ...newNode,
            position: {
              x: newNodeX,
              y: prevNode.position.y + prevNodeHeight + NODE_GAP_Y,
            },
            selected: isSelected,
          };
        }
      }

      return { ...newNode, selected: isSelected };
    });

    const needsLayout = positionedNodes.some(
      (n) =>
        n.type !== 'trigger' &&
        !currentNodes.find((existing) => existing.id === n.id) &&
        (!n.position || (n.position.x === 0 && n.position.y === 0))
    );

    let finalNodes = needsLayout ? autoLayoutNodes(positionedNodes, newEdges) : positionedNodes;
    let finalEdges = [...newEdges];

    if (showAddPlaceholder) {
      let sourceNode: Node | undefined;
      if (addStepSourceNodeId) {
        sourceNode = finalNodes.find((n) => n.id === addStepSourceNodeId);
      }
      if (!sourceNode) {
        sourceNode = finalNodes[finalNodes.length - 1];
      }

      if (sourceNode) {
        finalNodes = finalNodes.map((node) => {
          if (node.id === sourceNode!.id) {
            return { ...node, data: { ...node.data, showAddPlaceholder: true } };
          }
          return node;
        });

        const sourceNodeData = sourceNode.data as any;
        const sourceStepType = sourceNodeData?.branchType ? 'condition_branch' : (sourceNodeData?.actionType || sourceNodeData?.step?.type || '');
        const sourceNodeHeight = sourceStepType === 'condition_branch' ? 80 : getTotalNodeHeight(sourceStepType);
        const sourceNodeWidth = 340;
        const placeholderWidth = 340;
        const NODE_GAP_Y = 100;
        const sourceCenterX = sourceNode.position.x + sourceNodeWidth / 2;
        const placeholderX = sourceCenterX - placeholderWidth / 2;

        const placeholderNode: Node = {
          id: '__placeholder__',
          type: 'placeholder',
          position: {
            x: placeholderX,
            y: sourceNode.position.y + sourceNodeHeight + NODE_GAP_Y,
          },
          data: {},
          draggable: false,
          selectable: false,
        };

        finalNodes = [...finalNodes, placeholderNode];
        finalEdges.push({
          id: `${sourceNode.id}-placeholder`,
          source: sourceNode.id,
          target: '__placeholder__',
          type: 'smoothstep',
        });
      }
    }

    setNodes(finalNodes);
    setEdges(finalEdges);

    const trackableIds = finalNodes
      .filter((n) => n.type !== 'trigger' && n.type !== 'condition_branch' && n.type !== 'sub_agent')
      .map((n) => n.id);
    const prevIds = prevStepNodeIdsRef.current;
    const newIds = trackableIds.filter((id) => !prevIds.has(id));
    prevStepNodeIdsRef.current = new Set(trackableIds);

    if (!isFirstSyncRef.current && newIds.length === 1) {
      const newId = newIds[0];
      const newNode = finalNodes.find((n) => n.id === newId);
      if (newNode) {
        const nodeData = newNode.data as any;
        const stepType = nodeData?.actionType || nodeData?.step?.type || '';
        const width = getNodeWidth(newNode);
        const height = newNode.type === 'placeholder' ? 80 : getNodeHeight(stepType);
        const centerX = newNode.position.x + width / 2;
        const centerY = newNode.position.y + height / 2;
        const { zoom } = getViewport();
        setCenter(centerX, centerY, { duration: 400, zoom, interpolate: 'linear' });
      }
    }
    isFirstSyncRef.current = false;
  }, [trigger, steps, selectedNodeId, showAddPlaceholder, addStepSourceNodeId, getNodes, setCenter, getViewport, onSelectTrigger, onSelectStep, onSelectBranch, onDeleteStep, onAddStep, onUpdateConfig, onAddSubAgent, onEditSubAgent]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, type: 'smoothstep' }, eds));
    },
    [setEdges]
  );

  const onNodeDrag = useCallback(
    (event: React.MouseEvent, draggedNode: Node) => {
      const guides: AlignmentGuide[] = [];
      const draggedNodeWidth = getNodeWidth(draggedNode);
      const nodeHeight = 100;
      const currentNodes = getNodes();

      const draggedLeftX = getNodeLeftX(draggedNode);
      const draggedRightX = getNodeRightX(draggedNode);
      const draggedCenterX = getNodeCenterX(draggedNode);
      const draggedTop = draggedNode.position.y;
      const draggedBottom = draggedNode.position.y + nodeHeight;

      let snapX: number | null = null;

      for (const node of currentNodes) {
        if (node.id === draggedNode.id) continue;

        const otherNodeWidth = getNodeWidth(node);
        const nodeLeftX = getNodeLeftX(node);
        const nodeRightX = getNodeRightX(node);
        const nodeCenterX = getNodeCenterX(node);
        const nodeTop = node.position.y;
        const nodeBottom = node.position.y + nodeHeight;

        const yStart = Math.min(draggedTop, nodeTop) + 20;
        const yEnd = Math.max(draggedBottom, nodeBottom) - 20;

        if (Math.abs(draggedCenterX - nodeCenterX) < ALIGNMENT_THRESHOLD) {
          guides.push({ x: nodeCenterX, type: 'center', yStart, yEnd });
          if (snapX === null) snapX = nodeCenterX - draggedNodeWidth / 2;
        }
        if (Math.abs(draggedLeftX - nodeLeftX) < ALIGNMENT_THRESHOLD) {
          guides.push({ x: nodeLeftX, type: 'left', yStart, yEnd });
          if (snapX === null) snapX = nodeLeftX;
        }
        if (Math.abs(draggedRightX - nodeRightX) < ALIGNMENT_THRESHOLD) {
          guides.push({ x: nodeRightX, type: 'right', yStart, yEnd });
          if (snapX === null) snapX = nodeRightX - draggedNodeWidth;
        }
      }

      if (snapX !== null) {
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === draggedNode.id) {
              return { ...n, position: { x: snapX!, y: draggedNode.position.y } };
            }
            return n;
          })
        );
      }

      setAlignmentGuides(guides);
    },
    [getNodes, setNodes]
  );

  const onNodeDragStop = useCallback(
    (event: React.MouseEvent, node: Node) => {
      const draggedNodeWidth = getNodeWidth(node);
      const currentNodes = getNodes();

      let finalPosition = { ...node.position };
      let didSnap = false;

      const draggedLeftX = getNodeLeftX(node);
      const draggedRightX = getNodeRightX(node);
      const draggedCenterX = getNodeCenterX(node);

      for (const otherNode of currentNodes) {
        if (otherNode.id === node.id) continue;

        const nodeLeftX = getNodeLeftX(otherNode);
        const nodeRightX = getNodeRightX(otherNode);
        const nodeCenterX = getNodeCenterX(otherNode);

        if (Math.abs(draggedCenterX - nodeCenterX) < ALIGNMENT_THRESHOLD) {
          finalPosition.x = nodeCenterX - draggedNodeWidth / 2;
          didSnap = true;
          break;
        }
        if (Math.abs(draggedLeftX - nodeLeftX) < ALIGNMENT_THRESHOLD) {
          finalPosition.x = nodeLeftX;
          didSnap = true;
          break;
        }
        if (Math.abs(draggedRightX - nodeRightX) < ALIGNMENT_THRESHOLD) {
          finalPosition.x = nodeRightX - draggedNodeWidth;
          didSnap = true;
          break;
        }
      }

      setAlignmentGuides([]);

      if (didSnap) {
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === node.id) {
              return { ...n, position: finalPosition };
            }
            return n;
          })
        );
      }

      if (node.type === 'trigger') return;
      if (node.type === 'sub_agent') return;

      const updatedSteps = steps.map((step) => {
        if (step.id === node.id) {
          return {
            ...step,
            position: didSnap ? finalPosition : node.position,
          };
        }
        return step;
      });

      onStepsChange(updatedSteps);
    },
    [steps, onStepsChange, getNodes, setNodes]
  );

  const isValidConnection = useCallback<IsValidConnection>(
    (connection) => {
      if (connection.source === connection.target) return false;
      if (connection.target === 'trigger') return false;
      return true;
    },
    []
  );

  const onNodeClick = useCallback(
    (event: React.MouseEvent, clickedNode: Node) => {
      if (clickedNode.id === 'trigger' && triggerLocked) return;

      setNodes((nds) =>
        nds.map((n) => ({
          ...n,
          selected: n.id === clickedNode.id,
        }))
      );

      if (clickedNode.type !== 'condition_branch' && clickedNode.type !== 'sub_agent') {
        const nodeData = clickedNode.data as any;
        nodeData.onSelect?.();
      }
    },
    [setNodes, triggerLocked]
  );

  const handleResetLayout = useCallback(() => {
    const stepsWithoutPositions = steps.map((s: any) => ({ ...s, position: undefined }));

    const { nodes: freshNodes, edges: freshEdges } = workflowToFlow(trigger, stepsWithoutPositions, {
      onSelectTrigger,
      onSelectStep,
      onSelectBranch,
      onDeleteStep,
      onAddStep,
      onUpdateConfig,
    }, { triggerLocked, variableItems, onAddSubAgent, onEditSubAgent, labels: flowLabels });

    setNodes(freshNodes);
    setEdges(freshEdges);
  }, [trigger, steps, onSelectTrigger, onSelectStep, onSelectBranch, onDeleteStep, onAddStep, onUpdateConfig, onAddSubAgent, onEditSubAgent, triggerLocked, setNodes, setEdges]);

  const onPaneClick = useCallback(() => {
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        selected: false,
      }))
    );
    onDeselect?.();
  }, [setNodes, onDeselect]);

  return (
    <div className={className} style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <ReactFlow
        className="!bg-muted/30"
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 1.5, maxZoom: 1.5 }}
        defaultEdgeOptions={{
          type: 'smoothstep',
          style: { strokeWidth: 1.5 },
        }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        elementsSelectable={true}
        selectNodesOnDrag={false}
        zoomOnScroll={false}
        panOnScroll={true}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="currentColor" className="!text-muted-foreground/30" />
        <AlignmentGuidesOverlay guides={alignmentGuides} />
        <CustomControls onResetLayout={handleResetLayout} labels={labels} />
      </ReactFlow>
    </div>
  );
}

/**
 * Presentational ReactFlow workflow canvas.
 *
 * Self-contained and prop-driven — no data fetching, no i18n inside,
 * no router or toast dependencies. The host app maps its domain objects
 * to WorkflowStep / TriggerConfig, passes translated `labels`, and wires
 * `onNotify` to its preferred toast library.
 *
 * Shared by WeldConnect (workflows) and WeldCRM (sequences).
 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <div className={props.className} style={{ position: 'relative', width: '100%', height: '100%' }}>
        <WorkflowCanvasInner
          {...props}
          className="w-full h-full"
        />
      </div>
    </ReactFlowProvider>
  );
}
