/**
 * WeldFlow reporting hooks: status reports and the stakeholder register with
 * its RACI and communication plan (project-control slice D).
 *
 * Status report queries live under `reportKeys.all` and stakeholder queries
 * under `stakeholderKeys.all`; `platformSyncMap` invalidates those roots for
 * `project_status_report` and `project_stakeholder` events
 * (`lib/realtime/sync-map.ts`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { projectKeys } from '@/hooks/queries/use-projects-queries';
import type {
  CreateStakeholderInput,
  PutCommunicationPlanInput,
  PutRaciInput,
  PutStatusReportSettingsInput,
  Stakeholder,
  UpdateStakeholderInput,
  UpdateStatusReportInput,
} from '@weldsuite/app-api-client/domains/project-reporting';

export const reportKeys = {
  all: ['project-status-reports'] as const,
  list: (projectId: string) => [...reportKeys.all, 'list', projectId] as const,
  detail: (id: string) => [...reportKeys.all, 'detail', id] as const,
  settings: (projectId: string) => [...reportKeys.all, 'settings', projectId] as const,
};

export const stakeholderKeys = {
  all: ['project-stakeholders'] as const,
  list: (projectId: string) => [...stakeholderKeys.all, 'list', projectId] as const,
  raci: (projectId: string) => [...stakeholderKeys.all, 'raci', projectId] as const,
  plan: (projectId: string) => [...stakeholderKeys.all, 'plan', projectId] as const,
};

// -- Status reports -----------------------------------------------------------

export function useStatusReports(projectId: string) {
  const { projectReporting } = useAppApi();
  return useQuery({
    queryKey: reportKeys.list(projectId),
    queryFn: async () => (await projectReporting.listStatusReports({ projectId, limit: 100 })).data,
    enabled: !!projectId,
  });
}

export function useStatusReport(id: string | null) {
  const { projectReporting } = useAppApi();
  return useQuery({
    queryKey: reportKeys.detail(id ?? ''),
    queryFn: async () => (await projectReporting.getStatusReport(id as string)).data,
    enabled: !!id,
  });
}

export function useStatusReportSettings(projectId: string) {
  const { projectReporting } = useAppApi();
  return useQuery({
    queryKey: reportKeys.settings(projectId),
    queryFn: async () => (await projectReporting.getStatusReportSettings(projectId)).data,
    enabled: !!projectId,
  });
}

/** A mutation that refreshes the report queries (and the project, for its health) on success. */
function useReportMutation<TVars, TResult>(run: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reportKeys.all });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useCreateStatusReport() {
  const { projectReporting } = useAppApi();
  return useReportMutation(async (input: { projectId: string; period?: string }) => (await projectReporting.createStatusReport(input)).data);
}

export function useUpdateStatusReport() {
  const { projectReporting } = useAppApi();
  return useReportMutation(async (vars: { id: string; input: UpdateStatusReportInput }) => (await projectReporting.updateStatusReport(vars.id, vars.input)).data);
}

export function useRefreshStatusReport() {
  const { projectReporting } = useAppApi();
  return useReportMutation(async (id: string) => (await projectReporting.refreshStatusReport(id)).data);
}

export function usePublishStatusReport() {
  const { projectReporting } = useAppApi();
  return useReportMutation(async (id: string) => (await projectReporting.publishStatusReport(id)).data);
}

export function useDeleteStatusReport() {
  const { projectReporting } = useAppApi();
  return useReportMutation(async (id: string) => projectReporting.deleteStatusReport(id));
}

export function usePutStatusReportSettings() {
  const { projectReporting } = useAppApi();
  return useReportMutation(async (vars: { projectId: string; input: PutStatusReportSettingsInput }) => (await projectReporting.putStatusReportSettings(vars.projectId, vars.input)).data);
}

// -- Stakeholders -------------------------------------------------------------

export function useStakeholders(projectId: string) {
  const { projectReporting } = useAppApi();
  return useQuery({
    queryKey: stakeholderKeys.list(projectId),
    queryFn: async (): Promise<Stakeholder[]> => (await projectReporting.listStakeholders({ projectId, limit: 200 })).data,
    enabled: !!projectId,
  });
}

export function useRaci(projectId: string) {
  const { projectReporting } = useAppApi();
  return useQuery({
    queryKey: stakeholderKeys.raci(projectId),
    queryFn: async () => (await projectReporting.getRaci(projectId)).data,
    enabled: !!projectId,
  });
}

export function useCommunicationPlan(projectId: string) {
  const { projectReporting } = useAppApi();
  return useQuery({
    queryKey: stakeholderKeys.plan(projectId),
    queryFn: async () => (await projectReporting.getCommunicationPlan(projectId)).data,
    enabled: !!projectId,
  });
}

function useStakeholderMutation<TVars, TResult>(run: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: stakeholderKeys.all });
      // A report's recipients come from the register.
      void queryClient.invalidateQueries({ queryKey: reportKeys.all });
    },
  });
}

export function useCreateStakeholder() {
  const { projectReporting } = useAppApi();
  return useStakeholderMutation(async (input: CreateStakeholderInput) => (await projectReporting.createStakeholder(input)).data);
}

export function useUpdateStakeholder() {
  const { projectReporting } = useAppApi();
  return useStakeholderMutation(async (vars: { id: string; input: UpdateStakeholderInput }) => (await projectReporting.updateStakeholder(vars.id, vars.input)).data);
}

export function useDeleteStakeholder() {
  const { projectReporting } = useAppApi();
  return useStakeholderMutation(async (id: string) => projectReporting.deleteStakeholder(id));
}

export function useInviteToPortal() {
  const { projectReporting } = useAppApi();
  return useStakeholderMutation(async (id: string) => (await projectReporting.inviteToPortal(id)).data);
}

export function useRevokePortalAccess() {
  const { projectReporting } = useAppApi();
  return useStakeholderMutation(async (id: string) => (await projectReporting.revokePortalAccess(id)).data);
}

export function usePutRaci() {
  const { projectReporting } = useAppApi();
  return useStakeholderMutation(async (vars: { projectId: string; input: PutRaciInput }) => (await projectReporting.putRaci(vars.projectId, vars.input)).data);
}

export function usePutCommunicationPlan() {
  const { projectReporting } = useAppApi();
  return useStakeholderMutation(async (vars: { projectId: string; input: PutCommunicationPlanInput }) => (await projectReporting.putCommunicationPlan(vars.projectId, vars.input)).data);
}
