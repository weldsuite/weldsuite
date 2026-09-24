/**
 * WeldAgent skills / routines / approvals / memory — TanStack Query hooks.
 *
 * Each section is its own query so one failing call (e.g. the cloud computer
 * being unconfigured) never blanks the others.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CreateRoutineInput,
  UpdateRoutineInput,
  DecideApprovalInput,
} from '@weldsuite/app-api-client/schemas/weldagent-parity';

const ROOT = ['weldagent-parity'] as const;

export const agentParityKeys = {
  all: ROOT,
  skills: (agentId: string) => [...ROOT, 'skills', agentId] as const,
  routines: (agentId: string) => [...ROOT, 'routines', agentId] as const,
  approvals: (agentId: string) => [...ROOT, 'approvals', agentId] as const,
  memories: (agentId: string) => [...ROOT, 'memories', agentId] as const,
};

export interface AgentSkill {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

export interface AgentRoutine {
  id: string;
  name: string;
  instructions: string;
  scheduleKind: 'cron' | 'event' | 'connector';
  cronExpr: string | null;
  timezone: string;
  eventKey: string | null;
  enabled: boolean;
  requireApproval: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface AgentApproval {
  id: string;
  agentId: string;
  conversationId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'auto_approved' | 'expired';
  createdAt: string;
}

export interface AgentApprovalDecision extends AgentApproval {
  execution?: { ran: boolean; ok: boolean; result?: unknown; error?: string };
}

export interface AgentMemory {
  id: string;
  kind: 'preference' | 'fact' | 'summary' | 'correction';
  content: string;
}

export function useAgentSkills(agentId: string) {
  const { weldAgentParity } = useAppApi();
  return useQuery({
    queryKey: agentParityKeys.skills(agentId),
    queryFn: async () => ((await weldAgentParity.listAgentSkills(agentId)).data ?? []) as AgentSkill[],
    enabled: !!agentId,
  });
}

export function useAgentRoutines(agentId: string) {
  const { weldAgentParity } = useAppApi();
  return useQuery({
    queryKey: agentParityKeys.routines(agentId),
    queryFn: async () => ((await weldAgentParity.listRoutines(agentId)).data ?? []) as AgentRoutine[],
    enabled: !!agentId,
  });
}

/** Pending approvals for an agent. Polls so chat + Configure stay in sync. */
export function useAgentApprovals(agentId: string, opts?: { refetchInterval?: number | false }) {
  const { weldAgentParity } = useAppApi();
  return useQuery({
    queryKey: agentParityKeys.approvals(agentId),
    queryFn: async () =>
      ((await weldAgentParity.listApprovals({ agentId, status: 'pending' })).data ?? []) as AgentApproval[],
    enabled: !!agentId,
    refetchInterval: opts?.refetchInterval ?? 15_000,
  });
}

export function useAgentMemories(agentId: string) {
  const { weldAgentParity } = useAppApi();
  return useQuery({
    queryKey: agentParityKeys.memories(agentId),
    queryFn: async () => ((await weldAgentParity.listMemories(agentId)).data ?? []) as AgentMemory[],
    enabled: !!agentId,
  });
}

export function useCreateAgentSkill(agentId: string) {
  const { weldAgentParity } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; instructions: string }) => {
      const created = await weldAgentParity.createSkill({ ...data, status: 'active' });
      const id = (created.data as { id: string }).id;
      await weldAgentParity.enableSkill(agentId, id);
      return created.data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentParityKeys.skills(agentId) }),
  });
}

export function useDisableAgentSkill(agentId: string) {
  const { weldAgentParity } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) => weldAgentParity.disableSkill(agentId, skillId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentParityKeys.skills(agentId) }),
  });
}

export function useCreateAgentRoutine(agentId: string) {
  const { weldAgentParity } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<CreateRoutineInput, 'agentId'>) =>
      weldAgentParity.createRoutine({ ...data, agentId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentParityKeys.routines(agentId) }),
  });
}

export function useUpdateAgentRoutine(agentId: string) {
  const { weldAgentParity } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateRoutineInput }) =>
      weldAgentParity.updateRoutine(id, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentParityKeys.routines(agentId) }),
  });
}

export function useDeleteAgentRoutine(agentId: string) {
  const { weldAgentParity } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldAgentParity.deleteRoutine(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentParityKeys.routines(agentId) }),
  });
}

export function useTestAgentRoutine(agentId: string) {
  const { weldAgentParity } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await weldAgentParity.testRoutine(id)).data as { success?: boolean; text?: string; error?: string },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentParityKeys.routines(agentId) });
      void qc.invalidateQueries({ queryKey: ['workspace-agents'] });
    },
  });
}

/**
 * Approve / reject a parked tool call. Approving runs it server-side and posts
 * the outcome into the originating conversation, so messages are refreshed too.
 */
export function useDecideAgentApproval(agentId: string) {
  const { weldAgentParity } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: DecideApprovalInput & { id: string }) =>
      (await weldAgentParity.decideApproval(id, data)).data as AgentApprovalDecision,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: agentParityKeys.approvals(agentId) });
      void qc.invalidateQueries({ queryKey: ['weldagent'] });
      void qc.invalidateQueries({ queryKey: ['workspace-agents'] });
    },
  });
}

export function useCreateAgentMemory(agentId: string) {
  const { weldAgentParity } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      weldAgentParity.createMemory({ agentId, kind: 'preference', content }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentParityKeys.memories(agentId) }),
  });
}

export function useDeleteAgentMemory(agentId: string) {
  const { weldAgentParity } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldAgentParity.deleteMemory(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentParityKeys.memories(agentId) }),
  });
}
