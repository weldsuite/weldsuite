"use client"

/**
 * @weldsuite/ui — Workflow Canvas
 *
 * Public surface for the ReactFlow-based workflow editor canvas.
 * Import the component and types from this entry point:
 *
 *   import { WorkflowCanvas } from '@weldsuite/ui/components/workflow-canvas';
 */

export { WorkflowCanvas } from './workflow-canvas';
export type { WorkflowCanvasProps } from './workflow-canvas';

// Named node components (for consumers that need to mount them in their own ReactFlow)
export { TriggerNode } from './trigger-node';
export { ActionNode, PlaceholderNode } from './action-node';
export { ConditionNode, ConditionBranchNode } from './condition-node';
export { SubAgentNode } from './sub-agent-node';
export { AddNodePanel } from './add-node-panel';
export type { AddNodePanelLabels } from './add-node-panel';

// flow-utils
export {
  workflowToFlow,
  flowToWorkflow,
  autoLayoutNodes,
  getNodeHeight,
  getTotalNodeHeight,
  getActionIcon,
  getActionColor,
  getConditionBranchIds,
} from './flow-utils';
export type {
  FlowNodeType,
  TriggerNodeData,
  ActionNodeData,
  ConditionNodeData,
  ConditionBranchNodeData,
  SubAgentNodeData,
} from './flow-utils';

// Step validation (single source of truth for required-field checks)
export {
  getMissingRequiredFields,
  isStepConfigured,
  ACTION_REQUIRED_FIELDS,
} from './validation';
export type { MissingField } from './validation';

// Types
export type {
  WorkflowStep,
  TriggerConfig,
  TriggerCategory,
  VariableItem,
  WorkflowCanvasLabels,
} from './types';
export { DEFAULT_CANVAS_LABELS } from './types';
