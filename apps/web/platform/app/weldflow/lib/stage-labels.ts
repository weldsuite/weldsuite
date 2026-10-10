import { useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import type { TranslationsType } from '@/lib/i18n/types';

/**
 * English names the pipeline-stages API seeds for a new project
 * (`DEFAULT_STAGES` in flow-api), keyed by the system status they map to.
 * A stage still carrying one of these names is a built-in default, so its label
 * follows the UI language. Any other name is user-configured and shown as typed.
 */
const DEFAULT_STAGE_NAMES: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'In Review',
  in_review: 'In Review',
  testing: 'Testing',
  done: 'Done',
  cancelled: 'Cancelled',
};

type TaskLabels = TranslationsType['projects']['tasks'];

function labelForSystemStatus(systemStatus: string, labels: TaskLabels): string | undefined {
  switch (systemStatus) {
    case 'backlog':
      return labels.statusBacklog;
    case 'todo':
      return labels.statusTodo;
    case 'in_progress':
      return labels.statusInProgress;
    case 'review':
    case 'in_review':
      return labels.statusInReview;
    case 'testing':
      return labels.statusTesting;
    case 'done':
      return labels.statusDone;
    case 'cancelled':
      return labels.statusCancelled;
    default:
      return undefined;
  }
}

/**
 * Display label for a pipeline stage. Built-in default names are translated;
 * user-configured names are returned untouched.
 */
export function localizeStageName(
  name: string,
  systemStatus: string | null | undefined,
  labels: TaskLabels,
): string {
  if (!systemStatus) return name;
  const defaultName = DEFAULT_STAGE_NAMES[systemStatus];
  if (defaultName === undefined || name.trim().toLowerCase() !== defaultName.toLowerCase()) return name;
  return labelForSystemStatus(systemStatus, labels) ?? name;
}

/** Hook form of {@link localizeStageName}, bound to the current UI language. */
export function useStageLabel() {
  const { t } = useI18n();
  const labels = t.projects.tasks;
  return useCallback(
    (name: string, systemStatus: string | null | undefined) => localizeStageName(name, systemStatus, labels),
    [labels],
  );
}
