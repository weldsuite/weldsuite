/**
 * Workspace AI agents — TanStack Query hooks.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CreateWorkspaceAgentInput,
  UpdateWorkspaceAgentInput,
  WorkspaceAgent,
  WorkspaceAgentRun,
} from '@weldsuite/app-api-client/schemas/workspace-agents';

const agentKeys = {
  all: ['workspace-agents'] as const,
  list: (filters?: { status?: string }) => [...agentKeys.all, 'list', filters] as const,
  detail: (id: string) => [...agentKeys.all, 'detail', id] as const,
  runs: (agentId: string) => [...agentKeys.all, 'runs', agentId] as const,
  tools: [...agentKeys.all, 'tools'] as const,
  grantable: [...agentKeys.all, 'grantable'] as const,
};

/** @deprecated Use WorkspaceAgent — kept for sidebar consumers. */
export type Agent = WorkspaceAgent;

export type AgentRun = WorkspaceAgentRun;

export interface AgentWithRuns extends WorkspaceAgent {
  recentRuns: AgentRun[];
  availableTools?: Array<{
    id: string;
    name: string;
    description: string;
    requiredPermissions: string[];
  }>;
}

export function useAgents(filters?: { status?: string }) {
  const api = useAppApi();
  return useQuery({
    queryKey: agentKeys.list(filters),
    queryFn: async (): Promise<WorkspaceAgent[]> => {
      const res = await api.workspaceAgents.list(filters?.status);
      return res.data ?? [];
    },
  });
}

export function useAgent(id: string) {
  const api = useAppApi();
  return useQuery({
    queryKey: agentKeys.detail(id),
    queryFn: async (): Promise<AgentWithRuns | undefined> => {
      const [detail, runs] = await Promise.all([
        api.workspaceAgents.get(id),
        api.workspaceAgents.listRuns(id, 20),
      ]);
      if (!detail.data) return undefined;
      return {
        ...detail.data,
        recentRuns: runs.data ?? [],
      };
    },
    enabled: !!id,
  });
}

export function useAgentRuns(agentId: string) {
  const api = useAppApi();
  return useQuery({
    queryKey: agentKeys.runs(agentId),
    queryFn: async () => {
      const res = await api.workspaceAgents.listRuns(agentId);
      const runs = res.data ?? [];
      return { runs, total: runs.length };
    },
    enabled: !!agentId,
  });
}

export function useAgentTools() {
  const api = useAppApi();
  return useQuery({
    queryKey: agentKeys.tools,
    queryFn: async () => {
      const res = await api.workspaceAgents.listTools();
      return res.data ?? [];
    },
  });
}

export function useGrantablePermissions() {
  const api = useAppApi();
  return useQuery({
    queryKey: agentKeys.grantable,
    queryFn: async () => {
      const res = await api.workspaceAgents.listGrantablePermissions();
      return res.data ?? [];
    },
  });
}

export function useCreateAgent() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWorkspaceAgentInput) => api.workspaceAgents.create(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

export function useUpdateAgent(id: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateWorkspaceAgentInput) => api.workspaceAgents.update(id, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

export function useActivateAgent() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.workspaceAgents.activate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

export function usePauseAgent() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.workspaceAgents.pause(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

export function useDeleteAgent() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.workspaceAgents.delete(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

export function useRunAgent() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, message }: { id: string; message?: string }) =>
      api.workspaceAgents.run(id, { message }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: agentKeys.runs(vars.id) });
      void qc.invalidateQueries({ queryKey: agentKeys.detail(vars.id) });
    },
  });
}
