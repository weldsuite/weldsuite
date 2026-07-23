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
  | 'webhook'
  | 'manual'
  | 'api'
  | 'workflow_complete';

export interface WorkflowStep {
  id: string;
  type: string;
  name: string;
  description?: string;
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
}

export const DEFAULT_CANVAS_LABELS: Required<WorkflowCanvasLabels> = {
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  resetLayout: 'Reset layout',
  selectTrigger: 'Select Trigger',
  triggerLabels: {
    schedule: 'Scheduled Trigger',
    entity_event: 'Entity Event',
    webhook: 'Webhook Trigger',
    manual: 'Manual Trigger',
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
  },
  subAgentNodeAgentLabel: 'Agent',
  setupRequired: 'Setup required',
};
