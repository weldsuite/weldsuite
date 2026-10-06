import type { Node, Edge } from '@xyflow/react';
import type { WorkflowStep, TriggerConfig, BranchLabels } from './types';
import { isStepConfigured } from './validation';

// Node types used in the flow editor
export type FlowNodeType = 'trigger' | 'action' | 'condition' | 'sub_agent';

// Node data interfaces — extend Record<string, unknown> for @xyflow/react compatibility
export interface TriggerNodeData extends Record<string, unknown> {
  trigger: TriggerConfig;
  label: string;
  entityEvent?: string;
  isLastNode: boolean;
  /** Translated text of the add-step control under the last node. */
  addStepLabel?: string;
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
  /** Translated text of the add-step control under the last node. */
  addStepLabel?: string;
  isLastNode: boolean;
  showAddPlaceholder?: boolean;
  nodeId: string;
  onSelect?: () => void;
  onDelete?: () => void;
  onAddStep?: (sourceNodeId?: string) => void;
  onUpdateConfig?: (stepId: string, config: Record<string, unknown>) => void;
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
  /** Translated text of the add-step control under the last node. */
  addStepLabel?: string;
  isLastNode: boolean;
  nodeId: string;
  onSelect?: () => void;
  onDelete?: () => void;
  onAddStep?: (sourceNodeId?: string) => void;
  onUpdateConfig?: (stepId: string, config: Record<string, unknown>) => void;
}

export interface ConditionBranchNodeData extends Record<string, unknown> {
  branchType: string;  // 'if', 'if_not', 'escalated', 'completed', 'failed', etc.
  label: string;
  conditionLabel?: string;
  parentConditionId: string;
  parentConditionStepIndex: number;
  isLastNode: boolean;
  /** Translated text of the add-step control under an empty branch. */
  addStepLabel?: string;
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

/**
 * The union of every payload the canvas attaches to a React Flow node.
 * Layout helpers probe fields across node kinds, so they read through this
 * rather than through one concrete interface.
 */
export type FlowNodeData = Partial<
  TriggerNodeData &
    ActionNodeData &
    ConditionNodeData &
    ConditionBranchNodeData &
    SubAgentNodeData
>;

/** One branch of a multi-branch condition step. */
export interface ConditionBranch {
  value: string;
  label?: string;
}

/** `config` of a `condition` step. Legacy binary conditions omit `branches`. */
export interface ConditionStepConfig {
  expression?: string;
  field?: string;
  operator?: string;
  value?: unknown;
  thenAction?: string;
  elseAction?: string;
  branches?: ConditionBranch[];
}

/** `config` of an `ai_agent` step. */
export interface AiAgentStepConfig {
  subAgentIds?: string[];
  subAgentNames?: Record<string, string>;
}

/** A step placed under a condition branch, as the layout pass sees it. */
type BranchChild = Pick<WorkflowStep, 'id' | 'type'> & { parentBranchId?: string };

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
const BRANCH_GAP = 50; // Minimum gap between adjacent branch subtrees
const COLLISION_PADDING = 20; // Extra padding per side to account for borders, rings, shadows
const START_X = 600;
const START_Y = 50;

// --- Multi-branch helpers ---

/**
 * Steps drawn with branch nodes under them: a `condition` (if/else or value
 * branches) and a `loop` (one "for each item" branch holding the body).
 * Keep in sync with apps/workers/workflow-worker/src/engine/step-tree.ts.
 */
export function isBranchingStepType(stepType: string | undefined): boolean {
  return stepType === 'condition' || stepType === 'loop';
}

/** Branch node id of a loop's body. */
export function getLoopBodyBranchId(loopStepId: string): string {
  return `${loopStepId}_each`;
}

// Get all branch node IDs for a branching step.
// A loop has one body branch (<id>_each). A condition with config.branches
// returns branch_<value> IDs; otherwise legacy _if/_if_not.
export function getConditionBranchIds(step: { id: string; type?: string; config?: ConditionStepConfig }): string[] {
  if (step.type === 'loop') return [getLoopBodyBranchId(step.id)];
  const branches = step.config?.branches;
  if (branches && Array.isArray(branches)) {
    return branches.map((b) => `${step.id}_branch_${b.value}`);
  }
  // Legacy binary branches
  return [`${step.id}_if`, `${step.id}_if_not`];
}

// --- Post-placement collision detection helpers ---

// Get the effective width of a node based on its type
function getNodeWidth(node: Node): number {
  if (node.type === 'sub_agent') return SUB_AGENT_NODE_WIDTH;
  const data = node.data as FlowNodeData;
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
  const data = node.data as FlowNodeData;
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
    const data = n.data as FlowNodeData;
    return data?.step?.parentBranchId === branchNodeId;
  });

  for (const child of directChildren) {
    result.push(child);
    // If child is a condition or a loop, also include its branch nodes and their subtrees
    const data = child.data as FlowNodeData;
    const stepType = data?.actionType || data?.step?.type || '';
    if (isBranchingStepType(stepType)) {
      const branchIds = getConditionBranchIds({ id: child.id, type: stepType, config: data?.step?.config });
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

  const data = conditionNode.data as FlowNodeData;
  let parentBranchId = data?.step?.parentBranchId;

  while (parentBranchId) {
    depth++;
    // Find the condition node that owns this branch
    // Branch IDs are like "conditionId_if", "conditionId_if_not", or "conditionId_branch_<value>"
    const parentConditionId = parentBranchId
      .replace(/_branch_[^_]+$/, '')
      .replace(/_if_not$/, '')
      .replace(/_if$/, '')
      .replace(/_each$/, '');
    const parentCondition = allNodes.find((n) => n.id === parentConditionId);
    if (!parentCondition) break;
    const parentData = parentCondition.data as FlowNodeData;
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

  const data = node.data as FlowNodeData;

  // If this IS a condition_branch node, return it + its children subtree
  if (node.type === 'condition_branch') {
    return getSubtreeNodes(node.id, allNodes);
  }

  // If this node has a parentBranchId, return the full branch subtree it belongs to
  const parentBranchId = data?.step?.parentBranchId;
  if (parentBranchId) {
    return getSubtreeNodes(parentBranchId, allNodes);
  }

  // If this is a condition or loop node in main flow, return it + all branches
  const stepType = data?.actionType || data?.step?.type || '';
  if (isBranchingStepType(stepType)) {
    const branchIds = getConditionBranchIds({ id: node.id, type: stepType, config: data?.step?.config });
    const allBranchNodes = branchIds.flatMap((bid) => getSubtreeNodes(bid, allNodes));
    return [node, ...allBranchNodes];
  }

  // Main flow action node — just itself
  return [node];
}

// Push two overlapping subtrees apart, each by half of `pushAmount`, away from each other.
function pushApart(
  nodes: Node[],
  aSubtree: Node[],
  bSubtree: Node[],
  aCenterX: number,
  bCenterX: number,
  pushAmount: number,
): void {
  const half = Math.ceil(pushAmount / 2);
  if (aCenterX <= bCenterX) {
    shiftSubtree(nodes, aSubtree, -half);
    shiftSubtree(nodes, bSubtree, half);
  } else {
    shiftSubtree(nodes, aSubtree, half);
    shiftSubtree(nodes, bSubtree, -half);
  }
}

// Condition nodes, deepest first so inner collisions are resolved before outer ones
function getConditionNodesDeepestFirst(nodes: Node[]): Node[] {
  const conditionNodes = nodes.filter((n) => {
    const data = n.data as FlowNodeData;
    const stepType = data?.actionType || data?.step?.type || '';
    return isBranchingStepType(stepType) || n.type === 'condition';
  });
  conditionNodes.sort((a, b) => getConditionDepth(b.id, nodes) - getConditionDepth(a.id, nodes));
  return conditionNodes;
}

// Pass 1: Sibling branch check (If true vs If false of same condition)
function resolveSiblingBranchCollisions(nodes: Node[], conditionNodes: Node[]): boolean {
  let hadCollision = false;

  for (const condNode of conditionNodes) {
    const condData = condNode.data as FlowNodeData;
    const branchIds = getConditionBranchIds({ id: condNode.id, config: condData?.step?.config });
    const branchSubtrees = branchIds.map((bid) => getSubtreeNodes(bid, nodes)).filter((s) => s.length > 0);

    // Check each adjacent pair of sibling branches for overlap
    for (let bi = 0; bi < branchSubtrees.length - 1; bi++) {
      const leftSub = branchSubtrees[bi];
      const rightSub = branchSubtrees[bi + 1];
      if (!leftSub || !rightSub) continue;

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

  return hadCollision;
}

// Pass 2: Pairwise condition subtree check
function resolveConditionSubtreeCollisions(nodes: Node[], conditionNodes: Node[]): boolean {
  let hadCollision = false;

  const condFullSubtrees = conditionNodes.map((condNode) => {
    const condData = condNode.data as FlowNodeData;
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
      if (!a || !b) continue;

      // Skip if one is inside the other's subtree
      if (a.ids.has(b.condNode.id) || b.ids.has(a.condNode.id)) continue;

      const boxA = getBoundingBox(a.nodes);
      const boxB = getBoundingBox(b.nodes);

      const xOverlap = Math.min(boxA.maxX, boxB.maxX) - Math.max(boxA.minX, boxB.minX);
      const yOverlap = Math.min(boxA.maxY, boxB.maxY) - Math.max(boxA.minY, boxB.minY);

      if (xOverlap > 0 && yOverlap > 0) {
        hadCollision = true;
        const centerA = (boxA.minX + boxA.maxX) / 2;
        const centerB = (boxB.minX + boxB.maxX) / 2;
        pushApart(nodes, a.nodes, b.nodes, centerA, centerB, xOverlap + BRANCH_GAP);
      }
    }
  }

  return hadCollision;
}

// Node rectangle (with collision padding on each side) used by the brute-force pass
function getPaddedNodeRect(node: Node): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: node.position.x - COLLISION_PADDING,
    maxX: node.position.x + getNodeWidth(node) + COLLISION_PADDING,
    minY: node.position.y,
    maxY: node.position.y + getNodeEffectiveHeight(node),
  };
}

// Resolve a single overlapping node pair; returns true when it moved anything
function resolveNodePairCollision(nodes: Node[], a: Node, b: Node): boolean {
  if (a.id === 'trigger' || b.id === 'trigger') return false;
  // Skip sub_agent nodes — they live in their own visual lane
  if (a.type === 'sub_agent' || b.type === 'sub_agent') return false;

  const aRect = getPaddedNodeRect(a);
  const bRect = getPaddedNodeRect(b);

  const xOver = Math.min(aRect.maxX, bRect.maxX) - Math.max(aRect.minX, bRect.minX);
  const yOver = Math.min(aRect.maxY, bRect.maxY) - Math.max(aRect.minY, bRect.minY);
  if (!(xOver > 0 && yOver > 0)) return false;

  // Get containing subtrees so we shift coherently
  const aSub = getContainingSubtree(a.id, nodes);
  const bSub = getContainingSubtree(b.id, nodes);

  // Skip if they're in the same subtree (internal layout is fine)
  const aSubIds = new Set(aSub.map((n) => n.id));
  if (aSubIds.has(b.id)) return false;

  const aCenterX = (aRect.minX + aRect.maxX) / 2;
  const bCenterX = (bRect.minX + bRect.maxX) / 2;
  pushApart(nodes, aSub, bSub, aCenterX, bCenterX, xOver + BRANCH_GAP);
  return true;
}

// Pass 3: Brute-force ALL node pairs.
// This catches ANY remaining overlap regardless of subtree relationships.
function resolveAllPairCollisions(nodes: Node[]): boolean {
  let hadCollision = false;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (!a || !b) continue;
      if (resolveNodePairCollision(nodes, a, b)) hadCollision = true;
    }
  }

  return hadCollision;
}

// Post-placement collision resolution: detect and fix overlapping nodes
function resolveCollisions(nodes: Node[]): void {
  const MAX_ITERATIONS = 10;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const conditionNodes = getConditionNodesDeepestFirst(nodes);

    const siblingCollision = resolveSiblingBranchCollisions(nodes, conditionNodes);
    const subtreeCollision = resolveConditionSubtreeCollisions(nodes, conditionNodes);
    const pairCollision = resolveAllPairCollisions(nodes);

    if (!(siblingCollision || subtreeCollision || pairCollision)) break;
  }
}

// Get node height based on step type (single card only)
export function getNodeHeight(stepType: string): number {
  if (stepType === 'send_email') return SEND_EMAIL_NODE_HEIGHT;
  if (isBranchingStepType(stepType)) return CONDITION_NODE_HEIGHT;
  return NODE_HEIGHT;
}

// Compute the total height of branch children for a given branch
function getBranchChildrenHeight(branchChildrenMap: Map<string, BranchChild[]>, branchId: string): number {
  const children = branchChildrenMap.get(branchId) || [];
  if (children.length === 0) return 0;
  let total = 0;
  for (const child of children) {
    if (total > 0) total += NODE_GAP_Y;
    total += getTotalNodeHeight(child.type);
  }
  return NODE_GAP_Y + total; // gap between branch node and first child + children stack
}

// Height of the tallest branch-children stack under a condition step
function getTallestBranchChildrenHeight(branchChildrenMap: Map<string, BranchChild[]>, stepId: string): number {
  const branchIds = [`${stepId}_if`, `${stepId}_if_not`, getLoopBodyBranchId(stepId)];
  // Also check multi-branch IDs
  for (const [key] of branchChildrenMap) {
    if (key.startsWith(`${stepId}_branch_`)) {
      branchIds.push(key);
    }
  }
  let tallest = 0;
  for (const bid of branchIds) {
    tallest = Math.max(tallest, getBranchChildrenHeight(branchChildrenMap, bid));
  }
  return tallest;
}

// Get total visual height of a step including child nodes (e.g. condition branches, sub-agent satellites)
// Use this for spacing calculations between main flow steps
// subAgentCount: optional number of sub-agents for ai_agent steps
// branchChildrenMap: optional map of branch children for accurate condition height calculation
export function getTotalNodeHeight(stepType: string, subAgentCount?: number, branchChildrenMap?: Map<string, BranchChild[]>, stepId?: string): number {
  if (isBranchingStepType(stepType)) {
    // Condition card + gap + branch nodes + tallest branch children stack
    const branchChildrenExtra = branchChildrenMap && stepId
      ? getTallestBranchChildrenHeight(branchChildrenMap, stepId)
      : 0;
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
    case 'integration_event':
      return customLabels?.integration_event ?? 'Integration Event';
    case 'webhook':
      return customLabels?.webhook ?? 'Webhook Trigger';
    case 'manual':
      return customLabels?.manual ?? 'Manual Trigger';
    case 'api':
      return customLabels?.api ?? 'API Trigger';
    case 'workflow_complete':
      return customLabels?.workflow_complete ?? 'On Workflow Complete';
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
    create_customer: 'Create Customer',
    create_contact: 'Create Contact',
    update_contact: 'Update Contact',
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

type WorkflowFlowCallbacks = {
  onSelectTrigger?: () => void;
  onSelectStep?: (index: number) => void;
  onSelectBranch?: (branchNodeId: string, branchType: string, parentConditionId: string, parentConditionStepIndex: number) => void;
  onDeleteStep?: (index: number) => void;
  onAddStep?: (sourceNodeId?: string) => void;
  onUpdateConfig?: (stepId: string, config: Record<string, unknown>) => void;
};

type WorkflowFlowOptions = {
  triggerLocked?: boolean;
  variableItems?: Array<{ path: string; label: string; group: string; type?: string }>;
  onAddSubAgent?: (stepId: string) => void;
  onEditSubAgent?: (subAgentId: string) => void;
  labels?: {
    selectTrigger?: string;
    triggerLabels?: Record<string, string>;
    actionLabels?: Record<string, string>;
    setupRequired?: string;
    addStep?: string;
    branchLabels?: BranchLabels;
  };
};

type FlowPosition = { x: number; y: number };

const smoothstepEdge = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
  type: 'smoothstep',
});

// "entityType:eventType" for entity_event triggers that have both parts configured
function getTriggerEntityEvent(trigger: TriggerConfig | null): string | undefined {
  if (trigger?.type !== 'entity_event') return undefined;
  const t = trigger as TriggerConfig & { entityType?: string; eventType?: string };
  const cfg = t.config as { entityType?: string; eventType?: string } | undefined;
  const entityType = t.entityType || cfg?.entityType;
  const eventType = t.eventType || cfg?.eventType;
  if (entityType && eventType) return `${entityType}:${eventType}`;
  return undefined;
}

// Always create trigger node (even if no trigger configured yet)
function buildTriggerNode(
  trigger: TriggerConfig | null,
  steps: WorkflowStep[],
  callbacks?: WorkflowFlowCallbacks,
  options?: WorkflowFlowOptions,
): Node<TriggerNodeData> {
  return {
    id: 'trigger',
    type: 'trigger',
    position: { x: START_X, y: START_Y },
    data: {
      trigger: trigger || { type: 'manual', name: 'Trigger', config: {} } as TriggerConfig,
      label: trigger ? getTriggerLabel(trigger, options?.labels?.triggerLabels) : (options?.labels?.selectTrigger ?? 'Select Trigger'),
      entityEvent: getTriggerEntityEvent(trigger),
      isLastNode: steps.length === 0,
      addStepLabel: options?.labels?.addStep,
      locked: options?.triggerLocked,
      nodeId: 'trigger',
      onSelect: callbacks?.onSelectTrigger,
      onAddStep: callbacks?.onAddStep,
    },
  };
}

// Steps added under condition branches, grouped by the branch they belong to
function groupBranchChildren(steps: WorkflowStep[]): Map<string, WorkflowStep[]> {
  const branchChildrenMap = new Map<string, WorkflowStep[]>();
  for (const step of steps) {
    if (!step.parentBranchId) continue;
    const children = branchChildrenMap.get(step.parentBranchId) || [];
    children.push(step);
    branchChildrenMap.set(step.parentBranchId, children);
  }
  return branchChildrenMap;
}

// Pre-calculate cumulative Y positions for main flow steps based on total visual heights
function computeMainStepLayout(
  steps: WorkflowStep[],
  branchChildrenMap: Map<string, WorkflowStep[]>,
): { mainStepPositions: Map<string, number>; cumulativeY: number } {
  let cumulativeY = START_Y + NODE_HEIGHT + NODE_GAP_Y; // Start after trigger node
  const mainStepPositions = new Map<string, number>();
  for (const step of steps) {
    if (step.parentBranchId) continue;
    mainStepPositions.set(step.id, cumulativeY);
    const subAgentCount = step.type === 'ai_agent' ? ((step.config as AiAgentStepConfig)?.subAgentIds?.length || 0) : 0;
    cumulativeY += getTotalNodeHeight(step.type, subAgentCount, branchChildrenMap, step.id) + NODE_GAP_Y;
  }
  return { mainStepPositions, cumulativeY };
}

// Position a branch child below the branch node, or below the last sibling already placed in the same branch
function positionBranchChild(
  step: WorkflowStep,
  parentBranchId: string,
  branchNode: Node,
  nodes: Node[],
): FlowPosition {
  // Find sibling nodes already placed under this same branch
  const siblings = nodes.filter((n) => {
    const data = n.data as FlowNodeData;
    return data?.step?.parentBranchId === parentBranchId;
  });

  // Use the branch node center as anchor for horizontal centering
  const branchCenterX = branchNode.position.x + NODE_WIDTH / 2;
  const thisWidth = getStepWidth(step.type);
  const lastSibling = siblings[siblings.length - 1];

  if (lastSibling) {
    // Stack below the last sibling, centering based on the branch anchor X
    const lastSiblingData = lastSibling.data as FlowNodeData;
    const lastSiblingType = lastSiblingData?.actionType || lastSiblingData?.step?.type || '';
    const lastSiblingHeight = getTotalNodeHeight(lastSiblingType);
    return {
      x: branchCenterX - thisWidth / 2,
      y: lastSibling.position.y + lastSiblingHeight + NODE_GAP_Y,
    };
  }

  // First child — position below the branch node, centered
  const branchNodeHeight = 80;
  return {
    x: branchCenterX - thisWidth / 2,
    y: branchNode.position.y + branchNodeHeight + NODE_GAP_Y,
  };
}

// Where a step goes: its saved position, else below its branch node, else in the main flow column
function resolveStepPosition(
  step: WorkflowStep,
  index: number,
  nodes: Node[],
  mainStepPositions: Map<string, number>,
  cumulativeY: number,
): FlowPosition {
  if (step.position) return step.position;

  const parentBranchId = step.parentBranchId;
  if (!parentBranchId) {
    return { x: START_X, y: mainStepPositions.get(step.id) || cumulativeY };
  }

  const branchNode = nodes.find((n) => n.id === parentBranchId);
  if (!branchNode) {
    // Default fallback for branch children
    return { x: START_X, y: START_Y + (index + 1) * NODE_GAP_Y + NODE_HEIGHT };
  }
  return positionBranchChild(step, parentBranchId, branchNode, nodes);
}

// Widest card among a branch's children (never narrower than the standard width)
function getMaxChildWidth(children: WorkflowStep[]): number {
  return children.reduce((max: number, child) => Math.max(max, getStepWidth(child.type)), NODE_WIDTH);
}

function buildConditionBranchNode(args: {
  id: string;
  branchType: string;
  label: string;
  conditionLabel: string;
  step: WorkflowStep;
  stepIndex: number;
  x: number;
  y: number;
  hasChildren: boolean;
  callbacks?: WorkflowFlowCallbacks;
}): Node<ConditionBranchNodeData> {
  const { id, step, stepIndex, callbacks } = args;
  return {
    id,
    type: 'condition_branch',
    position: { x: args.x, y: args.y },
    data: {
      branchType: args.branchType,
      label: args.label,
      conditionLabel: args.conditionLabel,
      parentConditionId: step.id,
      parentConditionStepIndex: stepIndex,
      isLastNode: !args.hasChildren,
      nodeId: id,
      onSelect: () => callbacks?.onSelectStep?.(stepIndex),
      onSelectBranch: callbacks?.onSelectBranch,
      onAddStep: callbacks?.onAddStep,
    },
  };
}

// Multi-branch: compute needed width per branch based on children content
function buildMultiBranchNodes(
  step: WorkflowStep,
  stepIndex: number,
  position: FlowPosition,
  configBranches: ConditionBranch[],
  branchChildrenMap: Map<string, WorkflowStep[]>,
  callbacks?: WorkflowFlowCallbacks,
): Node<ConditionBranchNodeData>[] {
  const branchCount = configBranches.length;
  const branchWidths = configBranches.map((branch) => {
    const branchNodeId = `${step.id}_branch_${branch.value}`;
    const children = branchChildrenMap.get(branchNodeId) || [];
    return Math.max(NODE_WIDTH, getMaxChildWidth(children));
  });
  // Total width = sum of all branch widths + gaps between them
  const totalWidth = branchWidths.reduce((sum: number, w: number) => sum + w, 0) + (branchCount - 1) * BRANCH_GAP;
  // Center the whole structure around the condition's center X
  const condCenterX = position.x + NODE_WIDTH / 2;
  let currentX = condCenterX - totalWidth / 2;

  return configBranches.map((branch, branchIdx: number) => {
    const branchNodeId = `${step.id}_branch_${branch.value}`;
    // Place the branch node centered within its allocated width
    const branchWidth = branchWidths[branchIdx]!;
    const branchX = currentX + (branchWidth - NODE_WIDTH) / 2;
    currentX += branchWidth + BRANCH_GAP;
    return buildConditionBranchNode({
      id: branchNodeId,
      branchType: branch.value,
      label: branch.label ?? branch.value,
      conditionLabel: (step.config as ConditionStepConfig).field || '',
      step,
      stepIndex,
      x: branchX,
      y: position.y + NODE_GAP_Y + CONDITION_NODE_HEIGHT,
      hasChildren: branchChildrenMap.has(branchNodeId),
      callbacks,
    });
  });
}

// Legacy binary branches: "If true" / "If false"
function buildLegacyBranchNodes(
  step: WorkflowStep,
  stepIndex: number,
  position: FlowPosition,
  branchChildrenMap: Map<string, WorkflowStep[]>,
  callbacks?: WorkflowFlowCallbacks,
  branchLabels?: BranchLabels,
): Node<ConditionBranchNodeData>[] {
  const ifBranchNodeId = `${step.id}_if`;
  const ifNotBranchNodeId = `${step.id}_if_not`;
  const ifMaxWidth = getMaxChildWidth(branchChildrenMap.get(ifBranchNodeId) || []);
  const ifNotMaxWidth = getMaxChildWidth(branchChildrenMap.get(ifNotBranchNodeId) || []);
  const binaryTotalWidth = ifMaxWidth + ifNotMaxWidth + BRANCH_GAP;
  const condCenterX = position.x + NODE_WIDTH / 2;
  const ifBranchX = condCenterX - binaryTotalWidth / 2 + (ifMaxWidth - NODE_WIDTH) / 2;
  const ifNotBranchX = condCenterX + binaryTotalWidth / 2 - ifNotMaxWidth + (ifNotMaxWidth - NODE_WIDTH) / 2;
  const branchY = position.y + NODE_GAP_Y + CONDITION_NODE_HEIGHT;

  return [
    buildConditionBranchNode({
      id: ifBranchNodeId,
      branchType: 'if',
      label: branchLabels?.ifTrue ?? 'If true',
      conditionLabel: (step.config as ConditionStepConfig).expression || (branchLabels?.conditionMet ?? 'Condition met'),
      step,
      stepIndex,
      x: ifBranchX,
      y: branchY,
      hasChildren: branchChildrenMap.has(ifBranchNodeId),
      callbacks,
    }),
    buildConditionBranchNode({
      id: ifNotBranchNodeId,
      branchType: 'if_not',
      label: branchLabels?.ifFalse ?? 'If false',
      conditionLabel: branchLabels?.conditionNotMet ?? 'Condition not met',
      step,
      stepIndex,
      x: ifNotBranchX,
      y: branchY,
      hasChildren: branchChildrenMap.has(ifNotBranchNodeId),
      callbacks,
    }),
  ];
}

// A loop's single "for each item" branch, centered under the loop card
function buildLoopBodyNode(
  step: WorkflowStep,
  stepIndex: number,
  position: FlowPosition,
  branchChildrenMap: Map<string, WorkflowStep[]>,
  callbacks?: WorkflowFlowCallbacks,
  branchLabels?: BranchLabels,
): Node<ConditionBranchNodeData> {
  const branchNodeId = getLoopBodyBranchId(step.id);
  const items = (step.config as { items?: unknown } | undefined)?.items;
  return buildConditionBranchNode({
    id: branchNodeId,
    branchType: 'each',
    label: branchLabels?.forEachItem ?? 'For each item',
    conditionLabel: typeof items === 'string' ? items : '',
    step,
    stepIndex,
    x: position.x,
    y: position.y + NODE_GAP_Y + CONDITION_NODE_HEIGHT,
    hasChildren: branchChildrenMap.has(branchNodeId),
    callbacks,
  });
}

// The condition (or loop) card plus its branch nodes (loop body, multi-branch or legacy binary)
function buildConditionFlowNodes(
  step: WorkflowStep,
  stepIndex: number,
  position: FlowPosition,
  branchChildrenMap: Map<string, WorkflowStep[]>,
  callbacks?: WorkflowFlowCallbacks,
  options?: WorkflowFlowOptions,
): Node[] {
  const conditionNode: Node<ConditionNodeData> = {
    id: step.id,
    type: 'condition',
    position,
    data: {
      step,
      stepIndex,
      label: step.name || (options?.labels?.actionLabels?.[step.type] ?? (step.type === 'loop' ? 'Loop' : 'Condition')),
      condition: (step.config as ConditionStepConfig).expression,
      thenStepId: (step.config as ConditionStepConfig).thenAction,
      elseStepId: (step.config as ConditionStepConfig).elseAction,
      isConfigured: isStepConfigured(step),
      setupRequiredLabel: options?.labels?.setupRequired,
      addStepLabel: options?.labels?.addStep,
      isLastNode: false, // Condition node is never the "last" node visually
      labels: { label: options?.labels?.actionLabels?.[step.type] },
      nodeId: step.id,
      onSelect: () => callbacks?.onSelectStep?.(stepIndex),
      onDelete: () => callbacks?.onDeleteStep?.(stepIndex),
      onAddStep: callbacks?.onAddStep,
      onUpdateConfig: callbacks?.onUpdateConfig,
    },
  };

  const configBranches = (step.config as ConditionStepConfig)?.branches;
  const branchLabels = options?.labels?.branchLabels;
  let branchNodes: Node<ConditionBranchNodeData>[];
  if (step.type === 'loop') {
    branchNodes = [buildLoopBodyNode(step, stepIndex, position, branchChildrenMap, callbacks, branchLabels)];
  } else if (Array.isArray(configBranches)) {
    branchNodes = buildMultiBranchNodes(step, stepIndex, position, configBranches, branchChildrenMap, callbacks);
  } else {
    branchNodes = buildLegacyBranchNodes(step, stepIndex, position, branchChildrenMap, callbacks, branchLabels);
  }

  const addStepLabel = options?.labels?.addStep;
  return [conditionNode, ...branchNodes.map((node) => ({ ...node, data: { ...node.data, addStepLabel } }))];
}

// Sub-agent satellite nodes (and their dashed edges) for an ai_agent step
function buildSubAgentFlow(
  step: WorkflowStep,
  stepIndex: number,
  agentPosition: FlowPosition,
  callbacks?: WorkflowFlowCallbacks,
  options?: WorkflowFlowOptions,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const subAgentIds: string[] = (step.config as AiAgentStepConfig)?.subAgentIds || [];
  const subAgentNames: Record<string, string> = (step.config as AiAgentStepConfig)?.subAgentNames || {};

  subAgentIds.forEach((subAgentId, i) => {
    const subNodeId = `${step.id}_sub_${subAgentId}`;
    const subNode: Node<SubAgentNodeData> = {
      id: subNodeId,
      type: 'sub_agent',
      position: {
        x: agentPosition.x + SUB_AGENT_OFFSET_X,
        y: agentPosition.y + i * (SUB_AGENT_NODE_HEIGHT + SUB_AGENT_GAP_Y),
      },
      data: {
        subAgentId,
        subAgentName: subAgentNames[subAgentId] || 'Sub-Agent',
        parentAgentStepId: step.id,
        parentAgentStepIndex: stepIndex,
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

  return { nodes, edges };
}

// Regular action node (plus sub-agent satellites for ai_agent steps)
function buildActionFlowNodes(
  step: WorkflowStep,
  stepIndex: number,
  position: FlowPosition,
  isLastMainStep: boolean,
  branchChildrenMap: Map<string, WorkflowStep[]>,
  callbacks?: WorkflowFlowCallbacks,
  options?: WorkflowFlowOptions,
): { nodes: Node[]; edges: Edge[] } {
  // Center wider nodes (e.g. send_email) relative to standard width
  const centerOffset = getCenteringOffset(step.type);
  const adjustedPosition = centerOffset !== 0
    ? { x: position.x + centerOffset, y: position.y }
    : position;

  // A branch child is "last" when it ends its branch; a main-flow step when it ends the main flow
  const branchChildren = step.parentBranchId ? branchChildrenMap.get(step.parentBranchId) || [] : [];
  const isLastBranchChild = branchChildren.length > 0 && branchChildren[branchChildren.length - 1]!.id === step.id;
  const finalIsLastNode = step.parentBranchId ? isLastBranchChild : isLastMainStep;

  const actionNode: Node<ActionNodeData> = {
    id: step.id,
    type: 'action',
    position: adjustedPosition,
    data: {
      step,
      stepIndex,
      label: step.name || (options?.labels?.actionLabels?.[step.type] ?? getActionLabel(step.type)),
      actionType: step.type,
      isConfigured: isStepConfigured(step),
      setupRequiredLabel: options?.labels?.setupRequired,
      addStepLabel: options?.labels?.addStep,
      isLastNode: finalIsLastNode,
      nodeId: step.id,
      onSelect: () => callbacks?.onSelectStep?.(stepIndex),
      onDelete: () => callbacks?.onDeleteStep?.(stepIndex),
      onAddStep: callbacks?.onAddStep,
      onUpdateConfig: callbacks?.onUpdateConfig,
      onAddSubAgent: options?.onAddSubAgent,
      variableItems: options?.variableItems,
    },
  };

  if (step.type !== 'ai_agent') return { nodes: [actionNode], edges: [] };

  const subAgents = buildSubAgentFlow(step, stepIndex, adjustedPosition, callbacks, options);
  return { nodes: [actionNode, ...subAgents.nodes], edges: subAgents.edges };
}

// Edges chaining the main flow: each step to the next (condition branches feed into the next step)
function buildMainFlowEdges(steps: WorkflowStep[], branchChildrenMap: Map<string, WorkflowStep[]>): Edge[] {
  const edges: Edge[] = [];
  const mainFlowSteps = steps.filter((s) => !s.parentBranchId);
  for (let i = 0; i < mainFlowSteps.length - 1; i++) {
    const currentStep = mainFlowSteps[i]!;
    const nextStep = mainFlowSteps[i + 1]!;

    if (!isBranchingStepType(currentStep.type)) {
      edges.push(smoothstepEdge(`${currentStep.id}-${nextStep.id}`, currentStep.id, nextStep.id));
      continue;
    }

    for (const branchId of getConditionBranchIds(currentStep)) {
      const branchChildren = branchChildrenMap.get(branchId) || [];
      const lastNodeId = branchChildren.length > 0 ? branchChildren[branchChildren.length - 1]!.id : branchId;
      edges.push(smoothstepEdge(`${lastNodeId}-${nextStep.id}`, lastNodeId, nextStep.id));
    }
  }
  return edges;
}

// Every edge except the sub-agent ones: trigger, condition -> branches, branch -> children, main flow
function buildFlowEdges(steps: WorkflowStep[], branchChildrenMap: Map<string, WorkflowStep[]>): Edge[] {
  const edges: Edge[] = [];

  const firstMainStep = steps.find((s) => !s.parentBranchId);
  if (firstMainStep) {
    edges.push(smoothstepEdge(`trigger-${firstMainStep.id}`, 'trigger', firstMainStep.id));
  }

  // Connect condition and loop nodes to their branch nodes
  for (const step of steps) {
    if (!isBranchingStepType(step.type)) continue;
    for (const branchId of getConditionBranchIds(step)) {
      edges.push(smoothstepEdge(`${step.id}-${branchId}-branch`, step.id, branchId));
    }
  }

  // Connect branch nodes to their child steps (sequentially within each branch)
  branchChildrenMap.forEach((children, branchId) => {
    children.forEach((child, i) => {
      const sourceId = i === 0 ? branchId : children[i - 1]!.id;
      edges.push(smoothstepEdge(`${sourceId}-${child.id}`, sourceId, child.id));
    });
  });

  // Connect steps sequentially (for now, linear flow)
  edges.push(...buildMainFlowEdges(steps, branchChildrenMap));

  return edges;
}

// Convert workflow data to React Flow nodes and edges
export function workflowToFlow(
  trigger: TriggerConfig | null,
  steps: WorkflowStep[],
  callbacks?: WorkflowFlowCallbacks,
  options?: WorkflowFlowOptions
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [buildTriggerNode(trigger, steps, callbacks, options)];
  const edges: Edge[] = [];

  const branchChildrenMap = groupBranchChildren(steps);
  const { mainStepPositions, cumulativeY } = computeMainStepLayout(steps, branchChildrenMap);

  // The last step that is not under a condition branch
  const mainFlowSteps = steps.filter((s) => !s.parentBranchId);
  const lastMainStepId = mainFlowSteps[mainFlowSteps.length - 1]?.id;

  // Create action nodes
  steps.forEach((step, index) => {
    const position = resolveStepPosition(step, index, nodes, mainStepPositions, cumulativeY);

    if (isBranchingStepType(step.type)) {
      nodes.push(...buildConditionFlowNodes(step, index, position, branchChildrenMap, callbacks, options));
      return;
    }

    const isLastMainStep = !step.parentBranchId && lastMainStepId === step.id;
    const built = buildActionFlowNodes(step, index, position, isLastMainStep, branchChildrenMap, callbacks, options);
    nodes.push(...built.nodes);
    edges.push(...built.edges);
  });

  edges.push(...buildFlowEdges(steps, branchChildrenMap));

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
    const data = node.data as FlowNodeData;
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
    const data = node.data as FlowNodeData;
    const stepType = data?.actionType || data?.step?.type || '';
    const subAgentCount =
      stepType === 'ai_agent'
        ? ((data?.step?.config as AiAgentStepConfig | undefined)?.subAgentIds?.length ?? 0)
        : 0;
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
    create_customer: 'bg-emerald-500',
    create_contact: 'bg-emerald-500',
    update_contact: 'bg-emerald-500',
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
