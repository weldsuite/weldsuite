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
import { workflowToFlow, autoLayoutNodes, getNodeHeight, getTotalNodeHeight, type FlowNodeData } from './flow-utils';
import { type WorkflowStep, type TriggerConfig, type WorkflowCanvasLabels, type VariableItem, DEFAULT_CANVAS_LABELS } from './types';
import { Plus, Minus, Maximize } from 'lucide-react';

// Alignment threshold in pixels
const ALIGNMENT_THRESHOLD = 8;

/**
 * Keeps the previous reference while `value` is structurally unchanged.
 * Hosts often rebuild `trigger`, `steps` or `labels` inline on every render;
 * the node-sync effect calls setNodes, so an unstable prop would re-run it
 * after every render and loop (React #185, "Maximum update depth exceeded").
 * Only use it for plain data props, never for callbacks.
 */
function useStructurallyStable<T>(value: T): T {
  const ref = useRef<{ key: string; value: T } | null>(null);
  const key = JSON.stringify(value) ?? '';
  if (ref.current?.key !== key) {
    ref.current = { key, value };
  }
  return ref.current.value;
}

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

const NODE_GAP_Y = 100;
const PLACEHOLDER_NODE_ID = '__placeholder__';

// Nodes that represent a step on the main flow (not trigger, branch or sub-agent nodes)
const isTrackableStepNode = (node: Node) =>
  node.type !== 'trigger' && node.type !== 'condition_branch' && node.type !== 'sub_agent';

const isNodeSelected = (nodeId: string, selectedNodeId?: string | null) =>
  nodeId === selectedNodeId || (nodeId === 'trigger' && selectedNodeId === 'trigger');

const getStepTypeOf = (node: Node): string => {
  const data = node.data as FlowNodeData;
  return data?.actionType || data?.step?.type || '';
};

// Position directly below `above`, horizontally centred on it.
const positionBelow = (above: Node, aboveHeight: number) => {
  const aboveWidth = 340;
  const belowWidth = 340;
  return {
    x: above.position.x + aboveWidth / 2 - belowWidth / 2,
    y: above.position.y + aboveHeight + NODE_GAP_Y,
  };
};

// Nearest earlier node (skipping condition branches) that already exists on the canvas.
function findPreviousExistingNode(index: number, newNodes: Node[], currentNodes: Node[]): Node | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const candidate = newNodes[i]!;
    if (candidate.type === 'condition_branch') continue;
    const existing = currentNodes.find((n) => n.id === candidate.id);
    if (existing) return existing;
  }
  return undefined;
}

// Keep existing nodes where the user left them; drop brand-new nodes below their predecessor.
function positionSyncedNode(
  newNode: Node,
  index: number,
  newNodes: Node[],
  currentNodes: Node[],
  selected: boolean,
): Node {
  const existingNode = currentNodes.find((n) => n.id === newNode.id);
  if (existingNode) {
    return { ...newNode, position: existingNode.position, selected };
  }

  const hasParentBranch = (newNode.data as FlowNodeData)?.step?.parentBranchId;
  if (hasParentBranch && newNode.position && newNode.position.x !== 0) {
    return { ...newNode, selected };
  }

  if (newNode.type !== 'trigger' && newNode.type !== 'condition_branch' && index > 0) {
    const prevNode = findPreviousExistingNode(index, newNodes, currentNodes);
    if (prevNode) {
      const prevNodeHeight = getTotalNodeHeight(getStepTypeOf(prevNode));
      return { ...newNode, position: positionBelow(prevNode, prevNodeHeight), selected };
    }
  }

  return { ...newNode, selected };
}

// Adds the "new step goes here" placeholder under the source node (or the last node).
function withAddPlaceholder(
  nodes: Node[],
  edges: Edge[],
  addStepSourceNodeId?: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const sourceNode =
    (addStepSourceNodeId ? nodes.find((n) => n.id === addStepSourceNodeId) : undefined) ??
    nodes.at(-1);
  if (!sourceNode) return { nodes, edges };

  const flaggedNodes = nodes.map((node) =>
    node.id === sourceNode.id
      ? { ...node, data: { ...node.data, showAddPlaceholder: true } }
      : node,
  );

  const sourceNodeData = sourceNode.data as FlowNodeData;
  const sourceStepType = sourceNodeData?.branchType ? 'condition_branch' : getStepTypeOf(sourceNode);
  const sourceNodeHeight = sourceStepType === 'condition_branch' ? 80 : getTotalNodeHeight(sourceStepType);

  const placeholderNode: Node = {
    id: PLACEHOLDER_NODE_ID,
    type: 'placeholder',
    position: positionBelow(sourceNode, sourceNodeHeight),
    data: {},
    draggable: false,
    selectable: false,
  };

  return {
    nodes: [...flaggedNodes, placeholderNode],
    edges: [
      ...edges,
      {
        id: `${sourceNode.id}-placeholder`,
        source: sourceNode.id,
        target: PLACEHOLDER_NODE_ID,
        type: 'smoothstep',
      },
    ],
  };
}

// Centre point of a node, used to pan the viewport to a newly added step.
function getNodeCenter(node: Node): { x: number; y: number } {
  const height = node.type === 'placeholder' ? 80 : getNodeHeight(getStepTypeOf(node));
  return {
    x: node.position.x + getNodeWidth(node) / 2,
    y: node.position.y + height / 2,
  };
}

// The three vertical lines a node can align on, and where the dragged node snaps for each.
const ALIGNMENT_KINDS = [
  { type: 'center', getX: getNodeCenterX, snapOffset: (width: number) => -width / 2 },
  { type: 'left', getX: getNodeLeftX, snapOffset: () => 0 },
  { type: 'right', getX: getNodeRightX, snapOffset: (width: number) => -width },
] as const;

// Alignment guides (and the x to snap to) for a node being dragged over the others.
function computeAlignmentGuides(
  draggedNode: Node,
  currentNodes: Node[],
): { guides: AlignmentGuide[]; snapX: number | null } {
  const guides: AlignmentGuide[] = [];
  const draggedNodeWidth = getNodeWidth(draggedNode);
  const nodeHeight = 100;

  const draggedTop = draggedNode.position.y;
  const draggedBottom = draggedNode.position.y + nodeHeight;

  let snapX: number | null = null;

  for (const node of currentNodes) {
    if (node.id === draggedNode.id) continue;

    const yStart = Math.min(draggedTop, node.position.y) + 20;
    const yEnd = Math.max(draggedBottom, node.position.y + nodeHeight) - 20;

    for (const { type, getX, snapOffset } of ALIGNMENT_KINDS) {
      const lineX = getX(node);
      if (Math.abs(getX(draggedNode) - lineX) < ALIGNMENT_THRESHOLD) {
        guides.push({ x: lineX, type, yStart, yEnd });
        snapX ??= lineX + snapOffset(draggedNodeWidth);
      }
    }
  }

  return { guides, snapX };
}

// Custom controls component with Lucide icons
function CustomControls({ onResetLayout, labels }: Readonly<{ onResetLayout?: () => void; labels: Required<WorkflowCanvasLabels> }>) {
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
function AlignmentGuidesOverlay({ guides }: Readonly<{ guides: AlignmentGuide[] }>) {
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
  onUpdateConfig?: (stepId: string, config: Record<string, unknown>) => void;
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
  className?: string;
}

function WorkflowCanvasInner({
  trigger: triggerProp,
  steps: stepsProp,
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
  variableItems: variableItemsProp,
  labels: rawLabelsProp,
  className,
}: Readonly<WorkflowCanvasProps>) {
  const trigger = useStructurallyStable(triggerProp);
  const steps = useStructurallyStable(stepsProp);
  const variableItems = useStructurallyStable(variableItemsProp);
  const labelsProp = useStructurallyStable(rawLabelsProp);

  // Merge caller-provided labels with English defaults
  const labels: Required<WorkflowCanvasLabels> = useMemo(() => ({
    ...DEFAULT_CANVAS_LABELS,
    ...labelsProp,
    triggerLabels: { ...DEFAULT_CANVAS_LABELS.triggerLabels, ...labelsProp?.triggerLabels },
    actionLabels: { ...DEFAULT_CANVAS_LABELS.actionLabels, ...labelsProp?.actionLabels },
    branchLabels: { ...DEFAULT_CANVAS_LABELS.branchLabels, ...labelsProp?.branchLabels },
  }), [labelsProp]);

  const flowLabels = useMemo(() => ({
    selectTrigger: labels.selectTrigger,
    triggerLabels: labels.triggerLabels,
    actionLabels: labels.actionLabels,
    setupRequired: labels.setupRequired,
    addStep: labels.addStep,
    branchLabels: labels.branchLabels,
  }), [labels.selectTrigger, labels.triggerLabels, labels.actionLabels, labels.setupRequired, labels.addStep, labels.branchLabels]);

  const { zoomIn, zoomOut, getNodes, setCenter, getViewport } = useReactFlow();
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
  }, [trigger, steps, onSelectTrigger, onSelectStep, onSelectBranch, onDeleteStep, onAddStep, onUpdateConfig, onAddSubAgent, onEditSubAgent, triggerLocked, flowLabels, variableItems]);

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

    const newStepNodes = newNodes.filter(isTrackableStepNode);
    const hasAnyExistingStep = newStepNodes.some(n => currentNodes.find(existing => existing.id === n.id));
    const isBulkReplacement = newStepNodes.length > 0 && !hasAnyExistingStep;

    if (isBulkReplacement) {
      setNodes(newNodes.map(n => ({ ...n, selected: isNodeSelected(n.id, selectedNodeId) })));
      setEdges(newEdges);
      return;
    }

    const positionedNodes = newNodes.map((newNode, index) =>
      positionSyncedNode(newNode, index, newNodes, currentNodes, isNodeSelected(newNode.id, selectedNodeId)),
    );

    const needsLayout = positionedNodes.some(
      (n) =>
        n.type !== 'trigger' &&
        !currentNodes.some((existing) => existing.id === n.id) &&
        (!n.position || (n.position.x === 0 && n.position.y === 0))
    );

    let finalNodes = needsLayout ? autoLayoutNodes(positionedNodes, newEdges) : positionedNodes;
    let finalEdges: Edge[] = [...newEdges];

    if (showAddPlaceholder) {
      ({ nodes: finalNodes, edges: finalEdges } = withAddPlaceholder(finalNodes, finalEdges, addStepSourceNodeId));
    }

    setNodes(finalNodes);
    setEdges(finalEdges);

    const trackableIds = finalNodes.filter(isTrackableStepNode).map((n) => n.id);
    const prevIds = prevStepNodeIdsRef.current;
    const newIds = trackableIds.filter((id) => !prevIds.has(id));
    prevStepNodeIdsRef.current = new Set(trackableIds);

    const addedNode = !isFirstSyncRef.current && newIds.length === 1
      ? finalNodes.find((n) => n.id === newIds[0])
      : undefined;
    if (addedNode) {
      const { x, y } = getNodeCenter(addedNode);
      const { zoom } = getViewport();
      setCenter(x, y, { duration: 400, zoom, interpolate: 'linear' });
    }
    isFirstSyncRef.current = false;
  }, [trigger, steps, selectedNodeId, showAddPlaceholder, addStepSourceNodeId, getNodes, setCenter, getViewport, onSelectTrigger, onSelectStep, onSelectBranch, onDeleteStep, onAddStep, onUpdateConfig, onAddSubAgent, onEditSubAgent, flowLabels, variableItems, triggerLocked, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, type: 'smoothstep' }, eds));
    },
    [setEdges]
  );

  const onNodeDrag = useCallback(
    (event: React.MouseEvent, draggedNode: Node) => {
      const { guides, snapX } = computeAlignmentGuides(draggedNode, getNodes());

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

      const finalPosition = { ...node.position };
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
        const nodeData = clickedNode.data as FlowNodeData;
        nodeData.onSelect?.();
      }
    },
    [setNodes, triggerLocked]
  );

  const handleResetLayout = useCallback(() => {
    const stepsWithoutPositions = steps.map((s) => ({ ...s, position: undefined }));

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
  }, [trigger, steps, onSelectTrigger, onSelectStep, onSelectBranch, onDeleteStep, onAddStep, onUpdateConfig, onAddSubAgent, onEditSubAgent, triggerLocked, setNodes, setEdges, flowLabels, variableItems]);

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
 * to WorkflowStep / TriggerConfig and passes translated `labels`.
 *
 * Shared by WeldConnect (workflows) and WeldCRM (sequences).
 */
export function WorkflowCanvas(props: Readonly<WorkflowCanvasProps>) {
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
