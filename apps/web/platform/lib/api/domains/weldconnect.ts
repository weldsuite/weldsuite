/**
 * WeldConnect (automation) domain types.
 *
 * TRANSPORT NOTE (W5c legacy-worker phase-out): this module used to carry a
 * `taskWorkerApi` object with 82 calls against the obsolete api-worker under
 * `/task/*`. It was never exported and had zero call sites — the live
 * WeldConnect data path is `hooks/queries/use-automation-queries.ts`, which
 * already runs on app-api (`/api/workflows`, `/api/workflow-executions`, and
 * the sibling `/api/workflow-*` route groups). The dead client was removed
 * rather than repointed.
 *
 * The two interfaces below are the module's only exported surface; they are
 * consumed as `import type` by the WeldConnect home widgets and are kept
 * byte-identical so those consumers are untouched.
 */

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  version: number;
  triggers?: any[];
  steps?: any[];
  settings?: Record<string, unknown>;
  tags?: string[];
  folderId?: string;
  createdBy?: string;
  executionCount?: number;
  successCount?: number;
  failureCount?: number;
  averageExecutionTime?: number;
  lastExecutedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowVersion: number;
  workflowName?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  triggerType?: string;
  triggeredBy?: string;
  triggerData?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  currentStepId?: string;
  currentStepIndex?: number;
  totalSteps?: number;
  output?: Record<string, unknown>;
  error?: {
    message: string;
    code?: string;
    stepId?: string;
    stepName?: string;
  };
  createdAt: string;
  updatedAt: string;
}
