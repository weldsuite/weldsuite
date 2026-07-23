import type { Node, Edge } from '@xyflow/react';
import type { WorkflowStep, TriggerConfig } from './types';
import { isStepConfigured } from './validation';

// Node types used in the flow editor
export type FlowNodeType = 'trigger' | 'action' | 'condition' | 'sub_agent';

// Node data interfaces — extend Record<string, unknown> for @xyflow/react compatibility
export interface TriggerNodeData extends Record<string, unknown> {
  trigger: TriggerConfig;
  label: string;
  entityEvent?: string;
  isLastNode: boolean;
  showAddPlaceholder?: boolean;
  locked?: boolean;
  nodeId: string;
  onSelect?: () => void;
  onAddStep?: (sourceNodeId?: string) => void;
}

export interface ActionNodeData extends Record<string, unknown> {
  step: WorkflowStep;
  stepIndex: number;
  label: string;
  actionType: string;
  isConfigured: boolean;
  /** Translated badge text shown when !isConfigured. */
  setupRequiredLabel?: string;
  isLastNode: boolean;
  showAddPlaceholder?: boolean;
  nodeId: string;
  onSelect?: () => void;
  onDelete?: () => void;
  onAddStep?: (sourceNodeId?: string) => void;
  onUpdateConfig?: (stepId: string, config: Record<string, any>) => void;
  onAddSubAgent?: (stepId: string) => void;
  variableItems?: Array<{ path: string; label: string; group: string; type?: string }>;
}

export interface ConditionNodeData extends Record<string, unknown> {
  step: WorkflowStep;
  stepIndex: number;
  label: string;
  condition?: string;
  thenStepId?: string;
  elseStepId?: string;
  isConfigured: boolean;
  /** Translated badge text shown when !isConfigured. */
  setupRequiredLabel?: string;
  isLastNode: boolean;
  nodeId: string;
  onSelect?: () => void;
  onDelete?: () => void;
  onAddStep?: (sourceNodeId?: string) => void;
  onUpdateConfig?: (stepId: string, config: Record<string, any>) => void;
}

export interface ConditionBranchNodeData extends Record<string, unknown> {
  branchType: string;  // 'if', 'if_not', 'escalated', 'completed', 'failed', etc.
  label: string;
  conditionLabel?: string;
  parentConditionId: string;
  parentConditionStepIndex: number;
  isLastNode: boolean;
  nodeId: string;
  onSelect?: () => void;
  onSelectBranch?: (branchNodeId: string, branchType: string, parentConditionId: string, parentConditionStepIndex: number) => void;
  onAddStep?: (sourceNodeId?: string) => void;
}

export interface SubAgentNodeData extends Record<string, unknown> {
  subAgentId: string;
  subAgentName: string;
  parentAgentStepId: string;
  parentAgentStepIndex: number;
  nodeId: string;
  onSelect?: () => void;
  onRemove?: () => void;
  onEditSubAgent?: (subAgentId: string) => void;
}

// Sub-agent layout constants
const SUB_AGENT_NODE_WIDTH = 220;
const SUB_AGENT_NODE_HEIGHT = 50;
const SUB_AGENT_OFFSET_X = 320;
const SUB_AGENT_GAP_Y = 20;

// Default node dimensions — every node is the same compact, display-only card.
const NODE_WIDTH = 340; // Matches w-[340px] in trigger/action/condition node CSS
const NODE_HEIGHT = 80;
const CONDITION_NODE_HEIGHT = NODE_HEIGHT; // Condition card is the same size as any action card
const SEND_EMAIL_NODE_WIDTH = NODE_WIDTH; // No special-size email node anymore
const SEND_EMAIL_NODE_HEIGHT = NODE_HEIGHT;
const NODE_GAP_Y = 100;
const BRANCH_OFFSET_DEFAULT = 250; // Default horizontal offset for condition branches
const BRANCH_GAP = 50; // Minimum gap between adjacent branch subtrees
const COLLISION_PADDING = 20; // Extra padding per side to account for borders, rings, shadows
const START_X = 600;
const START_Y = 50;

// --- Multi-branch helpers ---

// Get all branch node IDs for a condition step.
// If the step has config.branches, returns branch_<value> IDs; otherwise legacy _if/_if_not.
export function getConditionBranchIds(step: { id: string; config?: any }): string[] {
  const branches = step.config?.branches;
  if (branches && Array.isArray(branches)) {
    return branches.map((b: any) => `${step.id}_branch_${b.value}`);
  }
  // Legacy binary branches
  return [`${step.id}_if`, `${step.id}_if_not`];
}

// --- Post-placement collision detection helpers ---

// Get the effective width of a node based on its type
function getNodeWidth(node: Node): number {
  if (node.type === 'sub_agent') return SUB_AGENT_NODE_WIDTH;
  const data = node.data as any;
  const stepType = data?.actionType || data?.step?.type || '';
  if (stepType === 'send_email') return SEND_EMAIL_NODE_WIDTH;
  return NODE_WIDTH;
}

// Get width for a step type string (without needing a Node)
function getStepWidth(stepType: string): number {
  if (stepType === 'send_email') return SEND_EMAIL_NODE_WIDTH;
  return NODE_WIDTH;
}

// Calculate the X offset needed to center a node of a given width relative to the standard NODE_WIDTH
function getCenteringOffset(stepType: string): number {
  const width = getStepWidth(stepType);
  if (width === NODE_WIDTH) return 0;
  return -(width - NODE_WIDTH) / 2;
}

// Get the effective height of a node based on its type
function getNodeEffectiveHeight(node: Node): number {
  if (node.type === 'sub_agent') return SUB_AGENT_NODE_HEIGHT;
  const data = node.data as any;
  const stepType = data?.actionType || data?.step?.type || '';
  if (node.type === 'condition_branch') return NODE_HEIGHT;
  return getNodeHeight(stepType);
}

// Collect all nodes belonging to a branch subtree (branch node + all descendants)
function getSubtreeNodes(branchNodeId: string, allNodes: Node[]): Node[] {
  const result: Node[] = [];
  const branchNode = allNodes.find((n) => n.id === branchNodeId);
  if (branchNode) result.push(branchNode);

  // Find direct children (steps with parentBranchId === branchNodeId)
  const directChildren = allNodes.filter((n) => {
    const data = n.data as any;
    return data?.step?.parentBranchId === branchNodeId;
  });

  for (const child of directChildren) {
    result.push(child);
    // If child is a condition, also include its branch nodes and their subtrees
    const data = child.data as any;
    const stepType = data?.actionType || data?.step?.type || '';
    if (stepType === 'condition') {
      const branchIds = getConditionBranchIds({ id: child.id, config: data?.step?.config });
      for (const bid of branchIds) {
        result.push(...getSubtreeNodes(bid, allNodes));
      }
    }
  }

  return result;
}

// Compute axis-aligned bounding box for a set of nodes (includes collision padding)
function getBoundingBox(nodes: Node[]): { minX: number; maxX: number; minY: number; maxY: number } {
  if (nodes.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const node of nodes) {
    const w = getNodeWidth(node);
    const h = getNodeEffectiveHeight(node);
    const x = node.position.x - COLLISION_PADDING;
    const y = node.position.y;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + w + COLLISION_PADDING * 2);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + h);
  }
  return { minX, maxX, minY, maxY };
}

// Get the nesting depth of a condition node (0 = main flow, 1 = inside a branch, etc.)
function getConditionDepth(conditionNodeId: string, allNodes: Node[]): number {
  let depth = 0;
  const conditionNode = allNodes.find((n) => n.id === conditionNodeId);
  if (!conditionNode) return 0;

  const data = conditionNode.data as any;
  let parentBranchId = data?.step?.parentBranchId;

  while (parentBranchId) {
    depth++;
    // Find the condition node that owns this branch
    // Branch IDs are like "conditionId_if", "conditionId_if_not", or "conditionId_branch_<value>"
    const parentConditionId = parentBranchId.replace(/_branch_[^_]+$/, '').replace(/_if_not$/, '').replace(/_if$/, '');
    const parentCondition = allNodes.find((n) => n.id === parentConditionId);
    if (!parentCondition) break;
    const parentData = parentCondition.data as any;
    parentBranchId = parentData?.step?.parentBranchId;
  }

  return depth;
}

// Shift all nodes in a subtree by a given X delta
function shiftSubtree(nodes: Node[], subtreeNodes: Node[], deltaX: number) {
  const subtreeIds = new Set(subtreeNodes.map((n) => n.id));
  for (const node of nodes) {
    if (subtreeIds.has(node.id)) {
      node.position = { ...node.position, x: node.position.x + deltaX };
    }
  }
}

// Find the branch subtree that contains a given node (for shifting coherently)
function getContainingSubtree(nodeId: string, allNodes: Node[]): Node[] {
  const node = allNodes.find((n) => n.id === nodeId);
  if (!node) return [];

  const data = node.data as any;

  // If this IS a condition_branch node, return it + its children subtree
  if (node.type === 'condition_branch') {
    return getSubtreeNodes(node.id, allNodes);
  }

  // If this node has a parentBranchId, return the full branch subtree it belongs to
  const parentBranchId = data?.step?.parentBranchId;
  if (parentBranchId) {
    return getSubtreeNodes(parentBranchId, allNodes);
  }

  // If this is a condition node in main flow, return it + all branches
  const stepType = data?.actionType || data?.step?.type || '';
  if (stepType === 'condition') {
    const branchIds = getConditionBranchIds({ id: node.id, config: data?.step?.config });
    const allBranchNodes = branchIds.flatMap((bid) => getSubtreeNodes(bid, allNodes));
    return [node, ...allBranchNodes];
  }

  // Main flow action node — just itself
  return [node];
}

// Post-placement collision resolution: detect and fix overlapping nodes
function resolveCollisions(nodes: Node[]): void {
  const MAX_ITERATIONS = 10;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let hadCollision = false;

    // --- Pass 1: Sibling branch check (If true vs If false of same condition) ---
    const conditionNodes = nodes.filter((n) => {
      const data = n.data as any;
      const stepType = data?.actionType || data?.step?.type || '';
      return stepType === 'condition' || n.type === 'condition';
    });

    // Sort by depth (deepest first) so inner collisions are resolved before outer ones
    conditionNodes.sort((a, b) => {
      return getConditionDepth(b.id, nodes) - getConditionDepth(a.id, nodes);
    });

    for (const condNode of conditionNodes) {
      const condData = condNode.data as any;
      const branchIds = getConditionBranchIds({ id: condNode.id, config: condData?.step?.config });
      const branchSubtrees = branchIds.map((bid) => getSubtreeNodes(bid, nodes)).filter((s) => s.length > 0);

      // Check each adjacent pair of sibling branches for overlap
      for (let bi = 0; bi < branchSubtrees.length - 1; bi++) {
        const leftSub = branchSubtrees[bi];
        const rightSub = branchSubtrees[bi + 1];

        const leftBox = getBoundingBox(leftSub);
        const rightBox = getBoundingBox(rightSub);

        const overlap = (leftBox.maxX + BRANCH_GAP) - rightBox.minX;

        if (overlap > 0) {
          hadCollision = true;
          const shiftAmount = Math.ceil(overlap / 2);
          shiftSubtree(nodes, leftSub, -shiftAmount);
          shiftSubtree(nodes, rightSub, shiftAmount);
        }
      }
    }

    // --- Pass 2: Pairwise condition subtree check ---
    const condFullSubtrees = conditionNodes.map((condNode) => {
      const condData = condNode.data as any;
      const branchIds = getConditionBranchIds({ id: condNode.id, config: condData?.step?.config });
      const allBranchNodes = branchIds.flatMap((bid) => getSubtreeNodes(bid, nodes));
      const all = [condNode, ...allBranchNodes];
      const ids = new Set(all.map((n) => n.id));
      return { condNode, nodes: all, ids };
    });

    for (let i = 0; i < condFullSubtrees.length; i++) {
      for (let j = i + 1; j < condFullSubtrees.length; j++) {
        const a = condFullSubtrees[i];
        const b = condFullSubtrees[j];

        // Skip if one is inside the other's subtree
        if (a.ids.has(b.condNode.id) || b.ids.has(a.condNode.id)) continue;

        const boxA = getBoundingBox(a.nodes);
        const boxB = getBoundingBox(b.nodes);

        const xOverlap = Math.min(boxA.maxX, boxB.maxX) - Math.max(boxA.minX, boxB.minX);
        const yOverlap = Math.min(boxA.maxY, boxB.maxY) - Math.max(boxA.minY, boxB.minY);

        if (xOverlap > 0 && yOverlap > 0) {
          hadCollision = true;
          const pushAmount = xOverlap + BRANCH_GAP;
          const centerA = (boxA.minX + boxA.maxX) / 2;
          const centerB = (boxB.minX + boxB.maxX) / 2;

          if (centerA <= centerB) {
            shiftSubtree(nodes, a.nodes, -Math.ceil(pushAmount / 2));
            shiftSubtree(nodes, b.nodes, Math.ceil(pushAmount / 2));
          } else {
            shiftSubtree(nodes, a.nodes, Math.ceil(pushAmount / 2));
            shiftSubtree(nodes, b.nodes, -Math.ceil(pushAmount / 2));
          }
        }
      }
    }

    // --- Pass 3: Brute-force ALL node pairs ---
    // This catches ANY remaining overlap regardless of subtree relationships.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (a.id === 'trigger' || b.id === 'trigger') continue;
        // Skip sub_agent nodes — they live in their own visual lane
        if (a.type === 'sub_agent' || b.type === 'sub_agent') continue;

        const aW = getNodeWidth(a);
        const aH = getNodeEffectiveHeight(a);
        const aMinX = a.position.x - COLLISION_PADDING;
        const aMaxX = a.position.x + aW + COLLISION_PADDING;
        const aMinY = a.position.y;
        const aMaxY = a.position.y + aH;

        const bW = getNodeWidth(b);
        const bH = getNodeEffectiveHeight(b);
        const bMinX = b.position.x - COLLISION_PADDING;
        const bMaxX = b.position.x + bW + COLLISION_PADDING;
        const bMinY = b.position.y;
        const bMaxY = b.position.y + bH;

        const xOver = Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX);
        const yOver = Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY);

        if (xOver > 0 && yOver > 0) {
          // Get containing subtrees so we shift coherently
          const aSub = getContainingSubtree(a.id, nodes);
          const bSub = getContainingSubtree(b.id, nodes);

          // Skip if they're in the same subtree (internal layout is fine)
          const aSubIds = new Set(aSub.map((n) => n.id));
          if (aSubIds.has(b.id)) continue;

          hadCollision = true;
          const pushAmount = xOver + BRANCH_GAP;
          const aCenterX = (aMinX + aMaxX) / 2;
          const bCenterX = (bMinX + bMaxX) / 2;

          if (aCenterX <= bCenterX) {
            shiftSubtree(nodes, aSub, -Math.ceil(pushAmount / 2));
            shiftSubtree(nodes, bSub, Math.ceil(pushAmount / 2));
          } else {
            shiftSubtree(nodes, aSub, Math.ceil(pushAmount / 2));
            shiftSubtree(nodes, bSub, -Math.ceil(pushAmount / 2));
          }
        }
      }
    }

    if (!hadCollision) break;
  }
}

// Get node height based on step type (single card only)
export function getNodeHeight(stepType: string): number {
  if (stepType === 'send_email') return SEND_EMAIL_NODE_HEIGHT;
  if (stepType === 'condition') return CONDITION_NODE_HEIGHT;
  return NODE_HEIGHT;
}

// Compute the total height of branch children for a given branch
function getBranchChildrenHeight(branchChildrenMap: Map<string, any[]>, branchId: string): number {
  const children = branchChildrenMap.get(branchId) || [];
  if (children.length === 0) return 0;
  let total = 0;
  for (const child of children) {
    if (total > 0) total += NODE_GAP_Y;
    total += getTotalNodeHeight(child.type);
  }
  return NODE_GAP_Y + total; // gap between branch node and first child + children stack
}

// Get total visual height of a step including child nodes (e.g. condition branches, sub-agent satellites)
// Use this for spacing calculations between main flow steps
// subAgentCount: optional number of sub-agents for ai_agent steps
// branchChildrenMap: optional map of branch children for accurate condition height calculation
export function getTotalNodeHeight(stepType: string, subAgentCount?: number, branchChildrenMap?: Map<string, any[]>, stepId?: string): number {
  if (stepType === 'condition') {
    // Condition card + gap + branch nodes + tallest branch children stack
    let branchChildrenExtra = 0;
    if (branchChildrenMap && stepId) {
      // Find the tallest branch
      const branchIds = [`${stepId}_if`, `${stepId}_if_not`];
      // Also check multi-branch IDs
      for (const [key] of branchChildrenMap) {
        if (key.startsWith(`${stepId}_branch_`)) {
          branchIds.push(key);
        }
      }
      for (const bid of branchIds) {
        branchChildrenExtra = Math.max(branchChildrenExtra, getBranchChildrenHeight(branchChildrenMap, bid));
      }
    }
    return CONDITION_NODE_HEIGHT + NODE_GAP_Y + NODE_HEIGHT + branchChildrenExtra;
  }
  const baseHeight = getNodeHeight(stepType);
  // For ai_agent steps with sub-agents, ensure height covers the sub-agent stack
  if (stepType === 'ai_agent' && subAgentCount && subAgentCount > 0) {
    const subAgentStackHeight = subAgentCount * (SUB_AGENT_NODE_HEIGHT + SUB_AGENT_GAP_Y) - SUB_AGENT_GAP_Y;
    return Math.max(baseHeight, subAgentStackHeight);
  }
  return baseHeight;
}

// Get a user-friendly label for trigger type
function getTriggerLabel(trigger: TriggerConfig, customLabels?: Record<string, string>): string {
  if (!trigger) return customLabels?.trigger ?? 'Trigger';
  if (trigger.name) return trigger.name;

  switch (trigger.type) {
    case 'schedule':
      return customLabels?.schedule ?? 'Scheduled Trigger';
    case 'entity_event':
      return customLabels?.entity_event ?? 'Entity Event';
    case 'webhook':
      return customLabels?.webhook ?? 'Webhook Trigger';
    case 'manual':
      return customLabels?.manual ?? 'Manual Trigger';
    default:
      return customLabels?.trigger ?? 'Trigger';
  }
}

// Get a user-friendly label for action type
function getActionLabel(actionType: string): string {
  const labels: Record<string, string> = {
    send_email: 'Send Email',
    http_request: 'HTTP Request',
    delay: 'Delay',
    condition: 'Condition',
    loop: 'Loop',
    set_variable: 'Set Variable',
    transform_data: 'Transform Data',
    create_record: 'Create Record',
    update_record: 'Update Record',
    delete_record: 'Delete Record',
    query_data: 'Query Data',
    send_notification: 'Send Notification',
    run_script: 'Run Script',
    ai_generate: 'AI Generate',
    ai_extract: 'AI Extract',
    ai_summarize: 'AI Summarize',
    send_message: 'Send Bot Message',
    send_choices: 'Send Choices',
    collect_input: 'Collect Input',
    ai_agent: 'AI Agent',
    manual_step: 'Manual Step',
  };
  return labels[actionType] || actionType;
}

// Convert workflow data to React Flow nodes and edges
export function workflowToFlow(
  trigger: TriggerConfig | null,
  steps: WorkflowStep[],
  callbacks?: {
    onSelectTrigger?: () => void;
    onSelectStep?: (index: number) => void;
    onSelectBranch?: (branchNodeId: string, branchType: string, parentConditionId: string, parentConditionStepIndex: number) => void;
    onDeleteStep?: (index: number) => void;
    onAddStep?: (sourceNodeId?: string) => void;
    onUpdateConfig?: (stepId: string, config: Record<string, any>) => void;
  },
  options?: {
    triggerLocked?: boolean;
    variableItems?: Array<{ path: string; label: string; group: string; type?: string }>;
    onAddSubAgent?: (stepId: string) => void;
    onEditSubAgent?: (subAgentId: string) => void;
    labels?: {
      selectTrigger?: string;
      triggerLabels?: Record<string, string>;
      actionLabels?: Record<string, string>;
      setupRequired?: string;
    };
  }
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Always create trigger node (even if no trigger configured yet)
  const triggerNode: Node<TriggerNodeData> = {
    id: 'trigger',
    type: 'trigger',
    position: { x: START_X, y: START_Y },
    data: {
      trigger: trigger || { type: 'manual', name: 'Trigger', config: {} } as TriggerConfig,
      label: trigger ? getTriggerLabel(trigger, options?.labels?.triggerLabels) : (options?.labels?.selectTrigger ?? 'Select Trigger'),
      entityEvent: (() => {
        if (trigger?.type !== 'entity_event') return undefined;
        const t = trigger as any;
        const entityType = t.entityType || (t.config as any)?.entityType;
        const eventType = t.eventType || (t.config as any)?.eventType;
        if (entityType && eventType) return `${entityType}:${eventType}`;
        return undefined;
      })(),
      isLastNode: steps.length === 0,
      locked: options?.triggerLocked,
      nodeId: 'trigger',
      onSelect: callbacks?.onSelectTrigger,
      onAddStep: callbacks?.onAddStep,
    },
  };
  nodes.push(triggerNode);

  // Find steps that have parent branch IDs (steps added under condition branches)
  const stepsWithBranchParent = steps.filter((s: any) => s.parentBranchId);
  const branchChildrenMap = new Map<string, typeof steps>();
  stepsWithBranchParent.forEach((step: any) => {
    const children = branchChildrenMap.get(step.parentBranchId) || [];
    children.push(step);
    branchChildrenMap.set(step.parentBranchId, children);
  });

  // Pre-calculate cumulative Y positions for main flow steps based on total visual heights
  let cumulativeY = START_Y + NODE_HEIGHT + NODE_GAP_Y; // Start after trigger node
  const mainStepPositions = new Map<string, number>();
  steps.forEach((step) => {
    const stepAny = step as any;
    if (!stepAny.parentBranchId) {
      mainStepPositions.set(step.id, cumulativeY);
      const subAgentCount = step.type === 'ai_agent' ? ((step.config as any)?.subAgentIds?.length || 0) : 0;
      cumulativeY += getTotalNodeHeight(step.type, subAgentCount, branchChildrenMap, step.id) + NODE_GAP_Y;
    }
  });

  // Create action nodes
  steps.forEach((step, index) => {
    const stepAny = step as any;

    // Calculate position - if step has a parent branch, position below that branch
    let position = step.position;
    if (!position) {
      if (stepAny.parentBranchId) {
        // Default fallback for branch children
        position = { x: START_X, y: START_Y + (index + 1) * NODE_GAP_Y + NODE_HEIGHT };
      } else {
        position = { x: START_X, y: mainStepPositions.get(step.id) || cumulativeY };
      }
    }

    // If this step has a parent branch, reposition it below the parent branch node
    // or below the last sibling already placed in the same branch
    if (stepAny.parentBranchId && !step.position) {
      const parentBranchId = stepAny.parentBranchId as string;
      const branchNode = nodes.find((n) => n.id === parentBranchId);

      if (branchNode) {
        // Find sibling nodes already placed under this same branch
        const siblings = nodes.filter((n) => {
          const data = n.data as any;
          return data?.step?.parentBranchId === parentBranchId;
        });

        if (siblings.length > 0) {
          // Stack below the last sibling, centering based on the branch anchor X
          const lastSibling = siblings[siblings.length - 1];
          const lastSiblingData = lastSibling.data as any;
          const lastSiblingType = lastSiblingData?.actionType || lastSiblingData?.step?.type || '';
          const lastSiblingHeight = getTotalNodeHeight(lastSiblingType);
          // Use the branch node center as anchor for horizontal centering
          const branchCenterX = branchNode.position.x + NODE_WIDTH / 2;
          const thisWidth = getStepWidth(step.type);
          position = {
            x: branchCenterX - thisWidth / 2,
            y: lastSibling.position.y + lastSiblingHeight + NODE_GAP_Y,
          };
        } else {
          // First child — position below the branch node, centered
          const branchNodeHeight = 80;
          const branchCenterX = branchNode.position.x + NODE_WIDTH / 2;
          const thisWidth = getStepWidth(step.type);
          position = {
            x: branchCenterX - thisWidth / 2,
            y: branchNode.position.y + branchNodeHeight + NODE_GAP_Y,
          };
        }
      }
    }

    // Check if this is the last step without a branch parent, or the last child of its branch
    const stepsWithoutBranchParent = steps.filter((s: any) => !s.parentBranchId);
    const isLastNonBranchStep = stepsWithoutBranchParent.length > 0 &&
      stepsWithoutBranchParent[stepsWithoutBranchParent.length - 1].id === step.id;
    const isLastNode = !stepAny.parentBranchId && isLastNonBranchStep;

    if (step.type === 'condition') {
      // Main condition node
      const conditionNode: Node<ConditionNodeData> = {
        id: step.id,
        type: 'condition',
        position,
        data: {
          step,
          stepIndex: index,
          label: step.name || 'Condition',
          condition: (step.config as any).expression,
          thenStepId: (step.config as any).thenAction,
          elseStepId: (step.config as any).elseAction,
          isConfigured: isStepConfigured(step),
          setupRequiredLabel: options?.labels?.setupRequired,
          isLastNode: false, // Condition node is never the "last" node visually
          nodeId: step.id,
          onSelect: () => callbacks?.onSelectStep?.(index),
          onDelete: () => callbacks?.onDeleteStep?.(index),
          onAddStep: callbacks?.onAddStep,
          onUpdateConfig: callbacks?.onUpdateConfig,
        },
      };
      nodes.push(conditionNode);

      // Generate branch nodes — multi-branch or legacy binary
      const configBranches = (step.config as any)?.branches;
      if (configBranches && Array.isArray(configBranches)) {
        // Multi-branch: compute needed width per branch based on children content
        const branchCount = configBranches.length;
        const branchWidths = configBranches.map((branch: any) => {
          const branchNodeId = `${step.id}_branch_${branch.value}`;
          const children = branchChildrenMap.get(branchNodeId) || [];
          const maxChildWidth = children.reduce((max: number, child: any) => Math.max(max, getStepWidth(child.type)), NODE_WIDTH);
          return Math.max(NODE_WIDTH, maxChildWidth);
        });
        // Total width = sum of all branch widths + gaps between them
        const totalWidth = branchWidths.reduce((sum: number, w: number) => sum + w, 0) + (branchCount - 1) * BRANCH_GAP;
        // Center the whole structure around the condition's center X
        const condCenterX = position.x + NODE_WIDTH / 2;
        let currentX = condCenterX - totalWidth / 2;

        configBranches.forEach((branch: any, branchIdx: number) => {
          const branchNodeId = `${step.id}_branch_${branch.value}`;
          const branchHasChildren = branchChildrenMap.has(branchNodeId);
          // Place the branch node centered within its allocated width
          const branchX = currentX + (branchWidths[branchIdx] - NODE_WIDTH) / 2;
          currentX += branchWidths[branchIdx] + BRANCH_GAP;
          const branchNode: Node<ConditionBranchNodeData> = {
            id: branchNodeId,
            type: 'condition_branch',
            position: {
              x: branchX,
              y: position.y + NODE_GAP_Y + CONDITION_NODE_HEIGHT,
            },
            data: {
              branchType: branch.value,
              label: branch.label,
              conditionLabel: (step.config as any).field || '',
              parentConditionId: step.id,
              parentConditionStepIndex: index,
              isLastNode: !branchHasChildren,
              nodeId: branchNodeId,
              onSelect: () => callbacks?.onSelectStep?.(index),
              onSelectBranch: callbacks?.onSelectBranch,
              onAddStep: callbacks?.onAddStep,
            },
          };
          nodes.push(branchNode);
        });
      } else {
        // Legacy binary branches: "If true" / "If false"
        const ifBranchNodeId = `${step.id}_if`;
        const ifNotBranchNodeId = `${step.id}_if_not`;
        const ifChildren = branchChildrenMap.get(ifBranchNodeId) || [];
        const ifNotChildren = branchChildrenMap.get(ifNotBranchNodeId) || [];
        const ifMaxWidth = ifChildren.reduce((max: number, child: any) => Math.max(max, getStepWidth(child.type)), NODE_WIDTH);
        const ifNotMaxWidth = ifNotChildren.reduce((max: number, child: any) => Math.max(max, getStepWidth(child.type)), NODE_WIDTH);
        const binaryTotalWidth = ifMaxWidth + ifNotMaxWidth + BRANCH_GAP;
        const condCenterX = position.x + NODE_WIDTH / 2;
        const ifBranchX = condCenterX - binaryTotalWidth / 2 + (ifMaxWidth - NODE_WIDTH) / 2;
        const ifNotBranchX = condCenterX + binaryTotalWidth / 2 - ifNotMaxWidth + (ifNotMaxWidth - NODE_WIDTH) / 2;

        const ifBranchHasChildren = branchChildrenMap.has(ifBranchNodeId);
        const ifBranchNode: Node<ConditionBranchNodeData> = {
          id: ifBranchNodeId,
          type: 'condition_branch',
          position: {
            x: ifBranchX,
            y: position.y + NODE_GAP_Y + CONDITION_NODE_HEIGHT,
          },
          data: {
            branchType: 'if',
            label: 'If true',
            conditionLabel: (step.config as any).expression || 'Condition met',
            parentConditionId: step.id,
            parentConditionStepIndex: index,
            isLastNode: !ifBranchHasChildren,
            nodeId: ifBranchNodeId,
            onSelect: () => callbacks?.onSelectStep?.(index),
            onSelectBranch: callbacks?.onSelectBranch,
            onAddStep: callbacks?.onAddStep,
          },
        };
        nodes.push(ifBranchNode);

        const ifNotBranchHasChildren = branchChildrenMap.has(ifNotBranchNodeId);
        const ifNotBranchNode: Node<ConditionBranchNodeData> = {
          id: ifNotBranchNodeId,
          type: 'condition_branch',
          position: {
            x: ifNotBranchX,
            y: position.y + NODE_GAP_Y + CONDITION_NODE_HEIGHT,
          },
          data: {
            branchType: 'if_not',
            label: 'If false',
            conditionLabel: 'Condition not met',
            parentConditionId: step.id,
            parentConditionStepIndex: index,
            isLastNode: !ifNotBranchHasChildren,
            nodeId: ifNotBranchNodeId,
            onSelect: () => callbacks?.onSelectStep?.(index),
            onSelectBranch: callbacks?.onSelectBranch,
            onAddStep: callbacks?.onAddStep,
          },
        };
        nodes.push(ifNotBranchNode);
      }
    } else {
      // Regular action node — center wider nodes (e.g. send_email) relative to standard width
      const centerOffset = getCenteringOffset(step.type);
      const adjustedPosition = centerOffset !== 0
        ? { x: position.x + centerOffset, y: position.y }
        : position;

      // Check if this is the last child of its branch
      const branchChildren = stepAny.parentBranchId ? branchChildrenMap.get(stepAny.parentBranchId) || [] : [];
      const isLastBranchChild = branchChildren.length > 0 && branchChildren[branchChildren.length - 1].id === step.id;
      const finalIsLastNode = stepAny.parentBranchId ? isLastBranchChild : isLastNode;

      const actionNode: Node<ActionNodeData> = {
        id: step.id,
        type: 'action',
        position: adjustedPosition,
        data: {
          step,
          stepIndex: index,
          label: step.name || (options?.labels?.actionLabels?.[step.type] ?? getActionLabel(step.type)),
          actionType: step.type,
          isConfigured: isStepConfigured(step),
          setupRequiredLabel: options?.labels?.setupRequired,
          isLastNode: finalIsLastNode,
          nodeId: step.id,
          onSelect: () => callbacks?.onSelectStep?.(index),
          onDelete: () => callbacks?.onDeleteStep?.(index),
          onAddStep: callbacks?.onAddStep,
          onUpdateConfig: callbacks?.onUpdateConfig,
          onAddSubAgent: options?.onAddSubAgent,
          variableItems: options?.variableItems,
        },
      };
      nodes.push(actionNode);

      // Generate sub-agent satellite nodes for ai_agent steps
      if (step.type === 'ai_agent') {
        const subAgentIds: string[] = (step.config as any)?.subAgentIds || [];
        const subAgentNames: Record<string, string> = (step.config as any)?.subAgentNames || {};

        subAgentIds.forEach((subAgentId, i) => {
          const subNodeId = `${step.id}_sub_${subAgentId}`;
          const subNode: Node<SubAgentNodeData> = {
            id: subNodeId,
            type: 'sub_agent',
            position: {
              x: adjustedPosition.x + SUB_AGENT_OFFSET_X,
              y: adjustedPosition.y + i * (SUB_AGENT_NODE_HEIGHT + SUB_AGENT_GAP_Y),
            },
            data: {
              subAgentId,
              subAgentName: subAgentNames[subAgentId] || 'Sub-Agent',
              parentAgentStepId: step.id,
              parentAgentStepIndex: index,
              nodeId: subNodeId,
              onSelect: () => options?.onEditSubAgent?.(subAgentId),
              onRemove: () => {
                const updatedIds = subAgentIds.filter((id) => id !== subAgentId);
                const { [subAgentId]: _, ...restNames } = subAgentNames;
                callbacks?.onUpdateConfig?.(step.id, {
                  subAgentIds: updatedIds,
                  subAgentNames: restNames,
                });
              },
              onEditSubAgent: options?.onEditSubAgent,
            },
          };
          nodes.push(subNode);

          // Dashed edge from head agent to sub-agent
          edges.push({
            id: `${step.id}-sub-${subAgentId}`,
            source: step.id,
            sourceHandle: 'subagents',
            target: subNodeId,
            type: 'smoothstep',
            animated: true,
            style: {
              strokeDasharray: '6 4',
              stroke: 'var(--color-border)',
              strokeWidth: 1.5,
            },
          });
        });
      }
    }
  });

  // Create edges
  const firstMainStep = steps.find((s: any) => !s.parentBranchId);
  if (firstMainStep) {
    edges.push({
      id: `trigger-${firstMainStep.id}`,
      source: 'trigger',
      target: firstMainStep.id,
      type: 'smoothstep',
    });
  }

  // Connect condition nodes to their branch nodes
  steps.forEach((step) => {
    if (step.type === 'condition') {
      const branchIds = getConditionBranchIds(step);
      branchIds.forEach((branchId) => {
        edges.push({
          id: `${step.id}-${branchId}-branch`,
          source: step.id,
          target: branchId,
          type: 'smoothstep',
        });
      });
    }
  });

  // Connect branch nodes to their child steps (sequentially within each branch)
  branchChildrenMap.forEach((children, branchId) => {
    children.forEach((child, i) => {
      if (i === 0) {
        edges.push({
          id: `${branchId}-${child.id}`,
          source: branchId,
          target: child.id,
          type: 'smoothstep',
        });
      } else {
        const prevChild = children[i - 1];
        edges.push({
          id: `${prevChild.id}-${child.id}`,
          source: prevChild.id,
          target: child.id,
          type: 'smoothstep',
        });
      }
    });
  });

  // Connect steps sequentially (for now, linear flow)
  const mainFlowSteps = steps.filter((s: any) => !s.parentBranchId);
  for (let i = 0; i < mainFlowSteps.length - 1; i++) {
    const currentStep = mainFlowSteps[i];
    const nextStep = mainFlowSteps[i + 1];

    if (currentStep.type === 'condition') {
      const branchIds = getConditionBranchIds(currentStep);
      branchIds.forEach((branchId) => {
        const branchChildren = branchChildrenMap.get(branchId) || [];
        const lastNodeId = branchChildren.length > 0 ? branchChildren[branchChildren.length - 1].id : branchId;
        edges.push({
          id: `${lastNodeId}-${nextStep.id}`,
          source: lastNodeId,
          target: nextStep.id,
          type: 'smoothstep',
        });
      });
    } else {
      edges.push({
        id: `${currentStep.id}-${nextStep.id}`,
        source: currentStep.id,
        target: nextStep.id,
        type: 'smoothstep',
      });
    }
  }

  // Post-placement collision detection: resolve any overlapping subtrees
  resolveCollisions(nodes);

  return { nodes, edges };
}

// Convert React Flow nodes and edges back to workflow data
export function flowToWorkflow(
  nodes: Node[],
  edges: Edge[]
): { steps: WorkflowStep[] } {
  const steps: WorkflowStep[] = [];

  // Find ordered steps by traversing from trigger
  const triggerNode = nodes.find((n) => n.type === 'trigger');
  if (!triggerNode) {
    // No trigger, just return steps in order (skip virtual sub_agent nodes)
    return {
      steps: nodes
        .filter((n) => n.type !== 'trigger' && n.type !== 'sub_agent')
        .map((n) => ({
          ...(n.data as unknown as ActionNodeData | ConditionNodeData).step,
          position: n.position,
        })),
    };
  }

  // Traverse edges to get ordered steps
  const visited = new Set<string>();
  const orderedIds: string[] = [];
  let currentId: string | undefined = triggerNode.id;

  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    if (currentId !== 'trigger') {
      orderedIds.push(currentId);
    }

    // Find next node via edge
    const outEdge = edges.find((e) => e.source === currentId);
    currentId = outEdge?.target;
  }

  // Build steps array in order
  for (const nodeId of orderedIds) {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) continue;

    const data = node.data as unknown as ActionNodeData | ConditionNodeData;
    steps.push({
      ...data.step,
      position: node.position,
    });
  }

  return { steps };
}

// Auto-layout nodes using simple vertical arrangement
export function autoLayoutNodes(
  nodes: Node[],
  edges: Edge[]
): Node[] {
  // Find trigger node
  const triggerNode = nodes.find((n) => n.type === 'trigger');
  const otherNodes = nodes.filter((n) => n.type !== 'trigger');

  const nodesWithFixedPosition = new Set<string>();
  nodes.forEach((node) => {
    const data = node.data as any;
    if (data?.step?.parentBranchId || node.type === 'condition_branch' || node.type === 'sub_agent') {
      nodesWithFixedPosition.add(node.id);
    }
  });

  // Build adjacency map from edges
  const childMap = new Map<string, string[]>();
  edges.forEach((edge) => {
    if (!childMap.has(edge.source)) {
      childMap.set(edge.source, []);
    }
    childMap.get(edge.source)!.push(edge.target);
  });

  const getTotalNodeHeightFromNode = (node: Node): number => {
    const data = node.data as any;
    const stepType = data?.actionType || data?.step?.type || '';
    const subAgentCount = stepType === 'ai_agent' ? (data?.step?.config?.subAgentIds?.length || 0) : 0;
    return getTotalNodeHeight(stepType, subAgentCount);
  };

  // Traverse and assign positions
  const positioned = new Map<string, { x: number; y: number }>();
  let currentY = START_Y;

  if (triggerNode) {
    positioned.set('trigger', { x: START_X, y: currentY });
    currentY += NODE_GAP_Y + NODE_HEIGHT;
  }

  const queue: string[] = triggerNode ? ['trigger'] : [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const children = childMap.get(nodeId) || [];

    children.forEach((childId) => {
      if (!positioned.has(childId)) {
        const childNode = nodes.find((n) => n.id === childId);

        if (nodesWithFixedPosition.has(childId) && childNode?.position) {
          positioned.set(childId, childNode.position);
        } else {
          positioned.set(childId, { x: START_X, y: currentY });
          const childHeight = childNode ? getTotalNodeHeightFromNode(childNode) : NODE_HEIGHT;
          currentY += NODE_GAP_Y + childHeight;
        }
      }
      queue.push(childId);
    });
  }

  // Position any unconnected nodes at the end
  otherNodes.forEach((node) => {
    if (!positioned.has(node.id)) {
      if (nodesWithFixedPosition.has(node.id) && node.position) {
        positioned.set(node.id, node.position);
      } else {
        positioned.set(node.id, { x: START_X, y: currentY });
        const nodeHeight = getTotalNodeHeightFromNode(node);
        currentY += NODE_GAP_Y + nodeHeight;
      }
    }
  });

  return nodes.map((node) => {
    const pos = positioned.get(node.id) || node.position;
    const width = getNodeWidth(node);
    const xOffset = width !== NODE_WIDTH ? -(width - NODE_WIDTH) / 2 : 0;
    return {
      ...node,
      position: { x: pos.x + xOffset, y: pos.y },
    };
  });
}

// Get the icon name for an action type
export function getActionIcon(actionType: string): string {
  const icons: Record<string, string> = {
    send_email: 'Mail',
    http_request: 'Globe',
    delay: 'Clock',
    condition: 'GitBranch',
    loop: 'Repeat',
    set_variable: 'Variable',
    transform_data: 'Wand2',
    create_record: 'Plus',
    update_record: 'Edit',
    delete_record: 'Trash',
    query_data: 'Search',
    send_notification: 'Bell',
    run_script: 'Code',
    ai_generate: 'Sparkles',
    ai_classify: 'Tags',
    ai_extract: 'FileSearch',
    ai_summarize: 'FileText',
    send_message: 'MessageSquareText',
    send_choices: 'ListChecks',
    collect_input: 'ClipboardList',
    ai_agent: 'Bot',
    manual_step: 'UserCheck',
  };
  return icons[actionType] || 'Box';
}

// Get the color for an action category
export function getActionColor(actionType: string): string {
  const categoryColors: Record<string, string> = {
    send_email: 'bg-blue-500',
    send_notification: 'bg-indigo-500',
    create_record: 'bg-green-500',
    update_record: 'bg-emerald-500',
    delete_record: 'bg-red-500',
    query_data: 'bg-teal-500',
    transform_data: 'bg-cyan-500',
    set_variable: 'bg-sky-500',
    condition: 'bg-amber-500',
    loop: 'bg-orange-500',
    delay: 'bg-yellow-500',
    http_request: 'bg-pink-500',
    run_script: 'bg-rose-500',
    ai_generate: 'bg-violet-500',
    ai_classify: 'bg-fuchsia-600',
    ai_extract: 'bg-fuchsia-500',
    ai_summarize: 'bg-purple-500',
    send_message: 'bg-cyan-500',
    send_choices: 'bg-cyan-500',
    collect_input: 'bg-cyan-500',
    ai_agent: 'bg-violet-600',
    manual_step: 'bg-amber-600',
  };
  return categoryColors[actionType] || 'bg-gray-500';
}
