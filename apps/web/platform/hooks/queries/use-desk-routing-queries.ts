/**
 * WeldDesk routing rules and teams for the settings pages.
 *
 * - `/api/desk/routing`: the ordered routing rules (`@weldsuite/db/lib/desk-routing`).
 * - `/api/helpdesk-departments`: the teams, with their members (`agentIds`,
 *   Clerk user ids), manager (`managerId`, a workspace member id) and
 *   escalation rules (run by the SLA sweep, `@weldsuite/db/lib/desk-escalation`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeskRoutingRuleInput, DeskRoutingState } from '@weldsuite/core-api-client/schemas/desk-routing';
import type {
  DESK_ESCALATION_CONDITIONS,
  DESK_ESCALATION_TARGETS,
} from '@weldsuite/core-api-client/schemas/helpdesk-departments';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';

export type DeskRoutingRule = DeskRoutingRuleInput;

export type DeskEscalationCondition = (typeof DESK_ESCALATION_CONDITIONS)[number];
export type DeskEscalationTarget = (typeof DESK_ESCALATION_TARGETS)[number];

export interface DeskEscalationRule {
  condition: DeskEscalationCondition;
  afterMinutes: number;
  escalateTo: DeskEscalationTarget;
  escalateToId?: string;
  notifyCustomer?: boolean;
}

/** A team (`helpdesk_departments` row) as the settings pages read it. */
export interface DeskTeam {
  id: string;
  createdAt: string;
  name: string;
  description: string | null;
  managerId: string | null;
  managerName: string | null;
  agentIds: string[];
  escalationRules: DeskEscalationRule[];
  isActive: boolean;
  sortOrder: number;
}

export interface DeskTeamInput {
  name: string;
  description?: string;
  managerId?: string | null;
  managerName?: string | null;
  agentIds?: string[];
  escalationRules?: DeskEscalationRule[];
  isActive?: boolean;
  sortOrder?: number;
}

/** A workspace member as the team pickers need them: the member id (manager) and the user id (members). */
export interface DeskTeamMember {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  status: string;
}

export const deskRoutingKeys = {
  all: ['desk', 'routing'] as const,
  rules: () => [...deskRoutingKeys.all, 'rules'] as const,
  teams: () => [...deskRoutingKeys.all, 'teams'] as const,
  members: () => [...deskRoutingKeys.all, 'members'] as const,
};

/** The routing rules, in the order they are checked. */
export function useDeskRoutingRules() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskRoutingKeys.rules(),
    queryFn: async (): Promise<DeskRoutingRule[]> => {
      const client = await getClient();
      const res = await client.get<{ data: DeskRoutingState }>('/desk/routing');
      return (res.data?.rules ?? []) as DeskRoutingRule[];
    },
  });
}

/** Replace the whole ordered list (the route takes it in one PUT). */
export function useSaveDeskRoutingRules() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rules: DeskRoutingRule[]) => {
      const client = await getClient();
      const res = await client.put<{ data: DeskRoutingState }>('/desk/routing', { rules });
      return (res.data?.rules ?? []) as DeskRoutingRule[];
    },
    onSuccess: (rules) => qc.setQueryData(deskRoutingKeys.rules(), rules),
  });
}

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toTeam(row: Record<string, unknown>): DeskTeam {
  return {
    id: String(row.id),
    createdAt: String(row.createdAt ?? ''),
    name: String(row.name ?? ''),
    description: (row.description as string | null | undefined) ?? null,
    managerId: (row.managerId as string | null | undefined) ?? null,
    managerName: (row.managerName as string | null | undefined) ?? null,
    agentIds: asList<string>(row.agentIds).filter((id) => typeof id === 'string'),
    escalationRules: asList<DeskEscalationRule>(row.escalationRules),
    isActive: row.isActive !== false,
    sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : 0,
  };
}

/** Every team (active or not), in their order: sort order, then newest first. */
export function useDeskTeams() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskRoutingKeys.teams(),
    queryFn: async (): Promise<DeskTeam[]> => {
      const client = await getClient();
      const teams: DeskTeam[] = [];
      let cursor: string | null = null;
      // A workspace has a handful of teams; the page cap only stops a runaway cursor.
      for (let page = 0; page < 5; page++) {
        const query: string = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
        const res = await client.get<{
          data: Array<Record<string, unknown>>;
          pagination?: { hasMore?: boolean; cursor?: string | null };
        }>(`/helpdesk-departments${query}`);
        teams.push(...(res.data ?? []).map(toTeam));
        cursor = res.pagination?.hasMore ? (res.pagination.cursor ?? null) : null;
        if (!cursor) break;
      }
      return teams;
    },
  });
}

function useInvalidateTeams() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: deskRoutingKeys.teams() }),
      // The inbox's team pickers and attribute options read the same rows.
      qc.invalidateQueries({ queryKey: ['desk'] }),
      qc.invalidateQueries({ queryKey: ['helpdesk', 'departments'] }),
    ]);
}

export function useCreateDeskTeam() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateTeams();
  return useMutation({
    mutationFn: async (data: DeskTeamInput) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>('/helpdesk-departments', data);
    },
    onSuccess: () => invalidate(),
  });
}

export function useUpdateDeskTeam() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateTeams();
  return useMutation({
    mutationFn: async ({ id, ...data }: Partial<DeskTeamInput> & { id: string }) => {
      const client = await getClient();
      return client.patch<{ data: { id: string } }>(`/helpdesk-departments/${id}`, data);
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeleteDeskTeam() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateTeams();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/helpdesk-departments/${id}`);
    },
    onSuccess: () => invalidate(),
  });
}

/** Workspace members who can be on a team (not removed), with both ids. */
export function useDeskTeamMembers() {
  const api = useAppApi();
  return useQuery({
    queryKey: deskRoutingKeys.members(),
    queryFn: async () => (await api.teamMembers.list()).data ?? [],
    staleTime: 60_000,
    select: (rows): DeskTeamMember[] =>
      rows
        .filter((m) => m.status?.toUpperCase() !== 'REMOVED')
        .map((m) => ({
          memberId: m.id,
          userId: m.userId,
          name: m.name?.trim() || m.email || m.userId,
          email: m.email ?? '',
          status: m.status,
        })),
  });
}
