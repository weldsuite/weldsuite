/**
 * WeldStash replenishment: settings, plans, reorder rules, planning runs,
 * incoming stock, CSV sales history imports and draft purchase orders from
 * plans. Typed domain client from `@weldsuite/app-api-client`.
 *
 * The whole surface is served by the Rust backend only (Kubernetes editions),
 * so every hook stays idle on Global (`isFeatureAvailable('stash-replenishment')`).
 */

import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';
import type {
  CreatePurchaseOrdersFromPlansInput,
  DismissPlanInput,
  ImportRowsInput,
  ListIncomingQuery,
  ListPlansQuery,
  ListRulesQuery,
  UpdateReplenishmentSettingsInput,
  UpsertReorderRuleInput,
} from '@weldsuite/app-api-client/schemas/replenishment';

export const replenishmentKeys = {
  all: ['weldstash', 'replenishment'] as const,
  settings: () => [...replenishmentKeys.all, 'settings'] as const,
  plans: () => [...replenishmentKeys.all, 'plans'] as const,
  planList: (params?: Omit<ListPlansQuery, 'cursor'>) => [...replenishmentKeys.plans(), 'list', params ?? {}] as const,
  plan: (id: string) => [...replenishmentKeys.plans(), 'detail', id] as const,
  demand: (id: string) => [...replenishmentKeys.plans(), 'demand', id] as const,
  rules: (params?: ListRulesQuery) => [...replenishmentKeys.all, 'rules', params ?? {}] as const,
  runs: () => [...replenishmentKeys.all, 'runs'] as const,
  incoming: (params?: ListIncomingQuery) => [...replenishmentKeys.all, 'incoming', params ?? {}] as const,
  imports: () => [...replenishmentKeys.all, 'imports'] as const,
};

/** How often to ask for the planning run while it is running. */
export const RUN_POLL_MS = 2000;

// ---------------------- Settings ----------------------

export function useReplenishmentSettings() {
  const api = useAppApi();
  return useQuery({
    queryKey: replenishmentKeys.settings(),
    queryFn: async () => (await api.replenishment.getSettings()).data,
    enabled: isFeatureAvailable('stash-replenishment'),
  });
}

export function useUpdateReplenishmentSettings() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: UpdateReplenishmentSettingsInput) => (await api.replenishment.updateSettings(data)).data,
    onSuccess: (settings) => {
      qc.setQueryData(replenishmentKeys.settings(), settings);
      // Turning it on or changing the run hour marks the workspace due; plans follow the next run.
      void qc.invalidateQueries({ queryKey: replenishmentKeys.runs() });
    },
  });
}

// ---------------------- Plans ----------------------

/** Cursor-paged plans (the Reorder and All items tabs). */
export function useInfinitePlans(params: Omit<ListPlansQuery, 'cursor'> = { limit: 100 }, enabled = true) {
  const api = useAppApi();
  return useInfiniteQuery({
    queryKey: replenishmentKeys.planList(params),
    queryFn: ({ pageParam }) => api.replenishment.listPlans({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? (lastPage.pagination.cursor ?? undefined) : undefined,
    enabled: enabled && isFeatureAvailable('stash-replenishment'),
  });
}

export function usePlan(id: string | null) {
  const api = useAppApi();
  return useQuery({
    queryKey: replenishmentKeys.plan(id ?? ''),
    queryFn: async () => (await api.replenishment.getPlan(id as string)).data,
    enabled: !!id && isFeatureAvailable('stash-replenishment'),
  });
}

export function usePlanDemand(id: string | null) {
  const api = useAppApi();
  return useQuery({
    queryKey: replenishmentKeys.demand(id ?? ''),
    queryFn: async () => (await api.replenishment.getPlanDemand(id as string)).data,
    enabled: !!id && isFeatureAvailable('stash-replenishment'),
  });
}

export function useDismissPlan() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data?: DismissPlanInput }) =>
      (await api.replenishment.dismissPlan(id, data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: replenishmentKeys.plans() }),
  });
}

export function useRestorePlan() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.replenishment.restorePlan(id)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: replenishmentKeys.plans() }),
  });
}

// ---------------------- Rules ----------------------

export function useUpsertReorderRule() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: UpsertReorderRuleInput) => (await api.replenishment.upsertRule(data)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: replenishmentKeys.plans() });
      void qc.invalidateQueries({ queryKey: [...replenishmentKeys.all, 'rules'] });
    },
  });
}

export function useDeleteReorderRule() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.replenishment.deleteRule(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: replenishmentKeys.plans() });
      void qc.invalidateQueries({ queryKey: [...replenishmentKeys.all, 'rules'] });
    },
  });
}

// ---------------------- Runs ----------------------

/** The latest planning runs, polled while the newest one is running. */
export function usePlanningRuns(limit = 5, enabled = true) {
  const api = useAppApi();
  return useQuery({
    queryKey: [...replenishmentKeys.runs(), limit],
    queryFn: async () => (await api.replenishment.listRuns({ limit })).data,
    enabled: enabled && isFeatureAvailable('stash-replenishment'),
    refetchInterval: (query) => (query.state.data?.[0]?.status === 'running' ? RUN_POLL_MS : false),
  });
}

/**
 * The newest planning run and whether one is running. Reloads the plans once
 * a run that was running finishes, so the lists show the new calculation.
 */
export function usePlanningRunStatus(enabled = true) {
  const qc = useQueryClient();
  const runs = usePlanningRuns(5, enabled);
  const latest = runs.data?.[0] ?? null;
  const running = latest?.status === 'running';
  const wasRunning = useRef(false);

  useEffect(() => {
    if (wasRunning.current && !running) {
      void qc.invalidateQueries({ queryKey: replenishmentKeys.plans() });
    }
    wasRunning.current = running;
  }, [running, qc]);

  return { latest, running, isLoading: runs.isLoading };
}

export function useStartPlanningRun() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.replenishment.startRun()).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: replenishmentKeys.runs() }),
  });
}

// ---------------------- Purchase orders from plans ----------------------

export function useCreatePurchaseOrdersFromPlans() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreatePurchaseOrdersFromPlansInput) =>
      (await api.replenishment.createPurchaseOrders(data)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: replenishmentKeys.plans() });
      void qc.invalidateQueries({ queryKey: ['weldstash', 'purchasing', 'orders'] });
    },
  });
}

// ---------------------- Incoming ----------------------

export function useIncomingStock(params: ListIncomingQuery, enabled = true) {
  const api = useAppApi();
  return useQuery({
    queryKey: replenishmentKeys.incoming(params),
    queryFn: async () => (await api.replenishment.listIncoming(params)).data,
    enabled: enabled && isFeatureAvailable('stash-replenishment'),
  });
}

// ---------------------- CSV imports ----------------------

export function useSalesHistoryImports() {
  const api = useAppApi();
  return useQuery({
    queryKey: replenishmentKeys.imports(),
    queryFn: async () => (await api.replenishment.listImports()).data,
    enabled: isFeatureAvailable('stash-replenishment'),
  });
}

export function useCreateSalesHistoryImport() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fileName: string) => (await api.replenishment.createImport({ fileName })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: replenishmentKeys.imports() }),
  });
}

export function useAddSalesHistoryRows() {
  const api = useAppApi();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: ImportRowsInput }) =>
      (await api.replenishment.addImportRows(id, data)).data,
  });
}

export function useCompleteSalesHistoryImport() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.replenishment.completeImport(id)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: replenishmentKeys.imports() });
      void qc.invalidateQueries({ queryKey: replenishmentKeys.settings() });
    },
  });
}

export function useDeleteSalesHistoryImport() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.replenishment.deleteImport(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: replenishmentKeys.imports() }),
  });
}
