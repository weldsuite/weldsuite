/**
 * Structural type duplicates lifted from packages/db/src/schema/workflows.ts.
 * No Drizzle runtime imports — safe to use in any package.
 *
 * KEEP IN SYNC with:
 *   packages/db/src/schema/workflows.ts  (WorkflowStep, TriggerConfig)
 */

export type TriggerCategory =
  | 'schedule'
  | 'entity_event'
  | 'integration_event'
  | 'webhook'
  | 'manual'
  | 'api'
  | 'workflow_complete';

export interface WorkflowStep {
  id: string;
  type: string;
  name: string;
  description?: string;
  /**
   * One-line, already-translated summary of the step's configuration, computed
   * by the host (e.g. "To: a@b.co"). The node shows it under the title in place
   * of the generic fallback; the user's own `description` still wins.
   */
  summary?: string;
  order?: number;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  condition?: {
    field: string;
    operator: string;
    value: unknown;
  };
  onError?: {
    action: 'stop' | 'continue' | 'retry' | 'goto';
    retryCount?: number;
    gotoStep?: string;
  };
  position?: { x: number; y: number };
  timeout?: number;
  retryPolicy?: {
    maxAttempts: number;
    delayMs: number;
    backoffMultiplier?: number;
  };
  continueOnError?: boolean;
  parentBranchId?: string;
}

export interface TriggerConfig {
  id: string;
  type: TriggerCategory;
  name: string;
  isEnabled: boolean;
  config: Record<string, unknown>;
  /**
   * One-line, already-translated summary of the trigger's configuration
   * (e.g. "Task created"), computed by the host. The node shows it instead of
   * "Click to configure" once the trigger is set up.
   */
  summary?: string;
}

/** A single variable item for the variable picker. */
export interface VariableItem {
  path: string;
  label: string;
  group: string;
  type?: string;
}

/**
 * All user-visible strings for WorkflowCanvas.
 * Pass `labels` from your i18n system; English defaults are built in.
 */
export interface WorkflowCanvasLabels {
  /** Tooltip for the zoom-in button. */
  zoomIn?: string;
  /** Tooltip for the zoom-out button. */
  zoomOut?: string;
  /** Tooltip for the reset-layout button. */
  resetLayout?: string;
  /** Label on the trigger node when no trigger is configured. */
  selectTrigger?: string;
  /** Map of trigger type → display label (e.g. { manual: 'Manual Trigger' }). */
  triggerLabels?: Record<string, string>;
  /** Map of action type → display label (e.g. { send_email: 'Send Email' }). */
  actionLabels?: Record<string, string>;
  /** Label shown on the sub-agent satellite node badge. */
  subAgentNodeAgentLabel?: string;
  /** Badge shown on an action/condition node that is missing required config. */
  setupRequired?: string;
  /** Text (and accessible name) of the add-step control under the last node. */
  addStep?: string;
  /** Labels of the branch nodes under a condition or a loop. */
  branchLabels?: BranchLabels;
}

/** Labels of the branch nodes the canvas draws under a condition or a loop. */
export interface BranchLabels {
  /** "If true" branch of a condition. */
  ifTrue?: string;
  /** "If false" branch of a condition. */
  ifFalse?: string;
  /** Subtitle of the "If true" branch when the condition has no summary. */
  conditionMet?: string;
  /** Subtitle of the "If false" branch. */
  conditionNotMet?: string;
  /** The body branch of a loop. */
  forEachItem?: string;
}

export const DEFAULT_CANVAS_LABELS: Required<WorkflowCanvasLabels> = {
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  resetLayout: 'Reset layout',
  selectTrigger: 'Select Trigger',
  triggerLabels: {
    schedule: 'Scheduled Trigger',
    entity_event: 'Entity Event',
    integration_event: 'Integration Event',
    webhook: 'Webhook Trigger',
    manual: 'Manual Trigger',
    api: 'API Trigger',
    workflow_complete: 'On Workflow Complete',
  },
  actionLabels: {
    send_email: 'Send Email',
    http_request: 'HTTP Request',
    delay: 'Delay',
    condition: 'Condition',
    loop: 'Loop',
    set_variable: 'Set Variable',
    transform_data: 'Transform Data',
    create_record: 'Create Record',
    create_customer: 'Create Company',
    create_contact: 'Create Contact',
    update_contact: 'Update Contact',
    create_lead: 'Create Lead',
    create_deal: 'Create Deal',
    move_deal_stage: 'Move Deal Stage',
    log_activity: 'Log Activity',
    create_task: 'Create Task',
    update_record: 'Update Record',
    delete_record: 'Delete Record',
    query_data: 'Query Data',
    send_notification: 'Send Notification',
    post_chat_message: 'Post Chat Message',
    run_script: 'Run Script',
    ai_generate: 'AI Generate',
    ai_extract: 'AI Extract',
    ai_summarize: 'AI Summarize',
    send_message: 'Send Bot Message',
    send_choices: 'Send Choices',
    collect_input: 'Collect Input',
    ai_agent: 'AI Agent',
    manual_step: 'Manual Step',
  },
  subAgentNodeAgentLabel: 'Agent',
  setupRequired: 'Setup required',
  addStep: 'Add step',
  branchLabels: {
    ifTrue: 'If true',
    ifFalse: 'If false',
    conditionMet: 'Condition met',
    conditionNotMet: 'Condition not met',
    forEachItem: 'For each item',
  },
};
