/**
 * Pure helpers shared by the executions list, the execution detail page and the
 * dashboard's recent activity, so every surface reads a run the same way.
 */

export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'skipped';

interface DurationSource {
  status: string;
  duration?: number | null;
  startedAt?: string | Date | null;
  completedAt?: string | Date | null;
}

interface ProgressSource {
  status: string;
  currentStepIndex?: number | null;
  totalSteps?: number | null;
}

/** `pending` is the legacy spelling of `queued`. */
export function normalizeExecutionStatus(status: string | null | undefined): string {
  return !status || status === 'pending' ? 'queued' : status;
}

function toTime(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * How long a run took, in ms. Prefers the stored duration, falls back to
 * `completedAt - startedAt` (older runs stored none), and for a run that is
 * still going returns the time elapsed so far. `null` when nothing is known.
 */
export function getExecutionDuration(execution: DurationSource, now: number): number | null {
  if (execution.duration != null && execution.duration > 0) return execution.duration;

  const startedAt = toTime(execution.startedAt);
  if (startedAt === null) return null;

  const completedAt = toTime(execution.completedAt);
  if (completedAt !== null) return Math.max(0, completedAt - startedAt);

  const status = normalizeExecutionStatus(execution.status);
  // A run paused on an approval is still going: its clock keeps running.
  if (status === 'running' || status === 'waiting_for_input') return Math.max(0, now - startedAt);

  return execution.duration ?? null;
}

/** Compact human duration: `340ms`, `4.2s`, `5m 12s`, `2h 5m`. */
export function formatExecutionDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

/**
 * Steps finished out of the total. `currentStepIndex` counts finished steps, but
 * a completed run always reads as fully done.
 */
export function getStepsProgress(execution: ProgressSource): { completed: number; total: number } {
  const total = Math.max(0, execution.totalSteps ?? 0);
  if (execution.status === 'completed') return { completed: total, total };
  return { completed: Math.min(Math.max(0, execution.currentStepIndex ?? 0), total), total };
}

/** The distinguishing tail of an id (`wex_muv5…` ids share their first characters). */
export function shortExecutionId(id: string, length = 8): string {
  return id.length <= length + 4 ? id : `…${id.slice(-length)}`;
}

export function isTestExecution(execution: { executionContext?: { isTest?: boolean } | null }): boolean {
  return execution.executionContext?.isTest === true;
}

/** The workflows a runs list knows about: one page of `GET /api/workflows`. */
export interface KnownWorkflows {
  names: ReadonlyMap<string, string>;
  /** Every workflow is in `names` (the page held them all), so a missing id was deleted. */
  complete: boolean;
}

/**
 * The name a run is listed under: its workflow's name now, so a rename shows
 * on its old runs too; the name stored with the run once the workflow is
 * gone or not loaded.
 */
export function runWorkflowName(
  run: { workflowId: string; workflowName?: string | null },
  known: KnownWorkflows,
  fallback: string,
): string {
  return known.names.get(run.workflowId) || run.workflowName || fallback;
}

/** Was the run's workflow deleted? Only certain once every workflow is known. */
export function isRunWorkflowDeleted(run: { workflowId: string }, known: KnownWorkflows): boolean {
  return known.complete && !known.names.has(run.workflowId);
}

export interface ExecutionErrorInfo {
  message: string;
  details?: unknown;
}

/** Reads the readable message (and optional structured details) out of an execution or step error. */
export function extractExecutionError(error: unknown): ExecutionErrorInfo | null {
  if (!error) return null;
  if (typeof error === 'string') return { message: error };
  if (typeof error === 'object') {
    const { message, details } = error as { message?: unknown; details?: unknown };
    const text = typeof message === 'string' ? message : '';
    if (!text && details === undefined) return null;
    const hasDetails = details !== undefined && details !== null && details !== '';
    return { message: text, ...(hasDetails ? { details } : {}) };
  }
  return null;
}
