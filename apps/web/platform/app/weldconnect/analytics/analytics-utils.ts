/**
 * Pure helpers for WeldConnect › Analytics.
 */

/** Pages in the error log; at least 1 so "page 1 of 1" reads right when empty. */
export function errorLogPageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Bars for "Errors by workflow": the server's top-10 list, labelled by the
 * workflow's name (a row whose workflow is gone gets `deletedLabel`).
 */
export function errorsByWorkflowChart(
  byWorkflow: ReadonlyArray<{ workflowId: string | null; workflowName: string | null; count: number }>,
  deletedLabel: string,
): Array<{ id: string; name: string; errors: number }> {
  return byWorkflow.map((row, index) => ({
    id: row.workflowId ?? `deleted-${index}`,
    name: row.workflowName ?? deletedLabel,
    errors: row.count,
  }));
}

export interface ExecutionCounts {
  total: number;
  completed: number;
  failed: number;
  running: number;
  queued: number;
}

/**
 * Overview figures from the dashboard counts. "In progress" is what is queued
 * or running; cancelled and timed-out runs count toward the total only.
 */
export function summarizeExecutions(counts: ExecutionCounts) {
  return {
    totalExecutions: counts.total,
    successfulExecutions: counts.completed,
    failedExecutions: counts.failed,
    inProgressExecutions: counts.running + counts.queued,
    successRate: counts.total > 0 ? Math.round((counts.completed / counts.total) * 1000) / 10 : 0,
  };
}
