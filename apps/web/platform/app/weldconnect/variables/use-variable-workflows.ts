import { useWorkflows } from '@/hooks/queries/use-automation-queries';
import { SEQUENCE_WORKFLOW_TAG } from '../mvp';

/**
 * The WeldConnect workflows a variable can be scoped to (CRM sequences left
 * out), for the Variables page's workflow names and the dialog's picker. Same
 * filters as the Workflows page, so the cache entry is shared.
 */
export function useVariableWorkflows() {
  return useWorkflows({ category: 'workflow', excludeTags: SEQUENCE_WORKFLOW_TAG, limit: 100 });
}
