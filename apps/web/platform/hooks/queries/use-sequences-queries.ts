/**
 * TanStack Query hooks for the Sequences feature, backed by `apps/workers/app-api`
 * at `/api/sequences/*` and `/api/customer-sequences/:customerId`.
 *
 * The legacy api-worker `/crm/sequences/*` surface was retired during the
 * companies/people refactor (see apps/api-worker/src/routes/crm/index.ts:353).
 * Workflow-engine actions (enroll, launch, start, pause/resume) dispatch
 * via app-api now, which talks to api-worker's EXECUTE_SEQUENCE workflow
 * runtime via the cross-worker binding configured in app-api/wrangler.toml.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type {
  SequenceSummary,
  SequenceDetail,
  SequenceEnrollment,
  SequenceEnrollmentFilters,
  CustomerSequenceEntry,
  PaginatedResponse,
  SingleResponse,
} from '@/lib/api/domains/weldcrm';

export type {
  SequenceSummary,
  SequenceDetail,
  SequenceEnrollment,
  
} from '@/lib/api/domains/weldcrm';

function buildQueryString(params: Record<string, unknown>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.set(key, String(value));
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

export const sequenceKeys = {
  all: ['sequences'] as const,
  lists: () => [...sequenceKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...sequenceKeys.lists(), filters] as const,
  detail: (id: string) => [...sequenceKeys.all, 'detail', id] as const,
  enrollments: (sequenceId: string, filters?: Record<string, unknown>) =>
    [...sequenceKeys.all, sequenceId, 'enrollments', filters] as const,
  customerSequences: (customerId: string) =>
    [...sequenceKeys.all, 'customer', customerId] as const,
};

export function useSequences(filters?: { page?: number; pageSize?: number; search?: string }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: sequenceKeys.list(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString((filters ?? {}) as Record<string, unknown>);
      return client.get<PaginatedResponse<SequenceSummary>>(`/sequences${query}`);
    },
  });
}

export function useSequence(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: sequenceKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<SingleResponse<SequenceDetail>>(`/sequences/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export function useSequenceEnrollments(sequenceId: string, filters?: SequenceEnrollmentFilters) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: sequenceKeys.enrollments(sequenceId, filters as Record<string, unknown> | undefined),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString((filters ?? {}) as Record<string, unknown>);
      return client.get<PaginatedResponse<SequenceEnrollment>>(
        `/sequences/${sequenceId}/enrollments${query}`,
      );
    },
    enabled: !!sequenceId,
  });
}

function useCustomerSequences(customerId: string, filters?: { page?: number; pageSize?: number }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: sequenceKeys.customerSequences(customerId),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString((filters ?? {}) as Record<string, unknown>);
      return client.get<PaginatedResponse<CustomerSequenceEntry>>(
        `/customer-sequences/${customerId}${query}`,
      );
    },
    enabled: !!customerId,
  });
}

export function useEnrollCustomers() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sequenceId,
      customerIds,
    }: {
      sequenceId: string;
      customerIds: string[];
    }) => {
      const client = await getClient();
      return client.post<SingleResponse<{ enrolled: number; enrollmentIds: string[] }>>(
        `/sequences/${sequenceId}/enroll`,
        { customerIds },
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: sequenceKeys.detail(variables.sequenceId) });
      qc.invalidateQueries({ queryKey: sequenceKeys.enrollments(variables.sequenceId) });
      qc.invalidateQueries({ queryKey: sequenceKeys.lists() });
    },
  });
}

export function usePauseEnrollment() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sequenceId, enrollmentId }: { sequenceId: string; enrollmentId: string }) => {
      const client = await getClient();
      return client.patch<SingleResponse<{ paused: boolean }>>(
        `/sequences/${sequenceId}/enrollments/${enrollmentId}/pause`,
        {},
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: sequenceKeys.enrollments(variables.sequenceId) });
    },
  });
}

export function useResumeEnrollment() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sequenceId, enrollmentId }: { sequenceId: string; enrollmentId: string }) => {
      const client = await getClient();
      return client.patch<SingleResponse<{ resumed: boolean }>>(
        `/sequences/${sequenceId}/enrollments/${enrollmentId}/resume`,
        {},
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: sequenceKeys.enrollments(variables.sequenceId) });
    },
  });
}

export function useUnenrollCustomer() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sequenceId, enrollmentId }: { sequenceId: string; enrollmentId: string }) => {
      const client = await getClient();
      await client.delete<void>(`/sequences/enrollments/${enrollmentId}`);
      return { sequenceId, enrollmentId };
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: sequenceKeys.enrollments(variables.sequenceId) });
      qc.invalidateQueries({ queryKey: sequenceKeys.detail(variables.sequenceId) });
    },
  });
}

/**
 * Launch a draft sequence — flips workflow status to active, converts every
 * pending enrollment to active, and triggers EXECUTE_SEQUENCE for each.
 */
export function useLaunchSequence() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sequenceId: string) => {
      const client = await getClient();
      return client.post<SingleResponse<{ activated: number }>>(
        `/sequences/${sequenceId}/launch`,
        {},
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sequenceKeys.all });
    },
  });
}

/**
 * Re-trigger workflow execution for every active enrollment that has no live
 * executionId. Idempotent — already-running enrollments are skipped.
 */
export function useStartSequence() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sequenceId: string) => {
      const client = await getClient();
      return client.post<SingleResponse<{ triggered: number }>>(
        `/sequences/${sequenceId}/start`,
        {},
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sequenceKeys.all });
    },
  });
}

/**
 * Pause a running sequence — flips workflow status to paused. The runtime
 * checks status on each step and short-circuits live instances.
 */
export function usePauseSequence() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sequenceId: string) => {
      const client = await getClient();
      return client.post<SingleResponse<{ paused: boolean }>>(
        `/sequences/${sequenceId}/pause`,
        {},
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sequenceKeys.all });
    },
  });
}
