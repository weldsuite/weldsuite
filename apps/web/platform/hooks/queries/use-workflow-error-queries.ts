/**
 * WeldConnect › Analytics › Errors: the `workflow_error_logs` rows the engine
 * writes for failed steps (Test runs and CRM sequences left out server-side),
 * and acknowledging them. Backed by connect-api `/api/workflow-dashboard/errors`.
 */

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { WELDCONNECT_API, automationKeys } from './use-automation-queries';

export type WorkflowErrorStatus = 'all' | 'acknowledged' | 'unacknowledged';

export interface WorkflowErrorItem {
  id: string;
  workflowId: string | null;
  workflowName: string | null;
  executionId: string | null;
  errorMessage: string;
  errorType: string | null;
  /** `error` for a failed run, `warning` for a step the run carried on past. */
  severity: string;
  stepId: string | null;
  stepName: string | null;
  stepType: string | null;
  isAcknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  occurredAt: string;
}

export interface WorkflowErrorsData {
  /** Rows matching the workflow + status filters. */
  total: number;
  /** Unacknowledged rows for the workflow filter, whatever the status filter. */
  unacknowledged: number;
  byType: Record<string, number>;
  /** Top 10 workflows by error count, under the same filters as `total`. */
  byWorkflow: Array<{ workflowId: string | null; workflowName: string | null; count: number }>;
  items: WorkflowErrorItem[];
  page: number;
  limit: number;
}

export interface WorkflowErrorsParams {
  workflowId?: string;
  status?: WorkflowErrorStatus;
  page?: number;
  limit?: number;
}

/** Every error query, for invalidation (also covers `useErrorStats`). */
const errorQueriesPrefix = [...automationKeys.all, 'error-stats'] as const;

export function useWorkflowErrors(params: WorkflowErrorsParams = {}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    // Own sub-key: `useErrorStats` caches the raw envelope under errorStats(params).
    queryKey: [...errorQueriesPrefix, 'list', params] as const,
    queryFn: async () => {
      const client = await getClient();
      const search = new URLSearchParams();
      if (params.workflowId) search.set('workflowId', params.workflowId);
      if (params.status) search.set('status', params.status);
      if (params.page) search.set('page', String(params.page));
      if (params.limit) search.set('limit', String(params.limit));
      const query = search.toString();
      const result = await client.get<{ data: WorkflowErrorsData }>(
        `${WELDCONNECT_API.dashboard}/errors${query ? `?${query}` : ''}`,
      );
      return result.data;
    },
    // Paging and switching the filter keep the current rows on screen.
    placeholderData: keepPreviousData,
  });
}

export function useAcknowledgeWorkflowError() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ data: WorkflowErrorItem }>(`${WELDCONNECT_API.dashboard}/errors/${id}/acknowledge`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: errorQueriesPrefix });
    },
  });
}

/** Acknowledge every error the view lists (optionally for one workflow), or the given ids. */
export function useAcknowledgeWorkflowErrors() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (target: { ids: string[] } | { all: true; workflowId?: string }) => {
      const client = await getClient();
      const result = await client.post<{ data: { acknowledged: number } }>(
        `${WELDCONNECT_API.dashboard}/errors/acknowledge`,
        target,
      );
      return result.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: errorQueriesPrefix });
    },
  });
}
