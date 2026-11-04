/**
 * WeldFlow portfolio hooks: capacity (load, bookings, resource requests,
 * profiles) and project intake (requests, funnel, roadmap, settings).
 *
 * Every portfolio query lives under `portfolioKeys.all`; `platformSyncMap`
 * invalidates that root for the portfolio entity events, so keep it in step
 * with `lib/realtime/sync-map.ts`.
 */

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useAppApi } from '@/lib/api/use-app-api';
import { useAllTeamMembers } from '@/hooks/queries/use-team-queries';
import type {
  BookResourceRequestInput,
  CapacityQuery,
  ConvertProjectRequestInput,
  CreateBookingInput,
  CreateProjectRequestInput,
  CreateResourceRequestInput,
  ListProjectRequestsQuery,
  ProjectRequest,
  RoadmapQuery,
  ScoreProjectRequestInput,
  UpdateBookingInput,
  UpdateFlowSettingsInput,
  UpdateMemberProfileInput,
  UpdateProjectRequestInput,
  UpdateResourceRequestInput,
} from '@weldsuite/app-api-client/domains/flow-portfolio';

export const portfolioKeys = {
  all: ['flow-portfolio'] as const,
  capacity: (query: CapacityQuery) => [...portfolioKeys.all, 'capacity', query] as const,
  resourceRequests: () => [...portfolioKeys.all, 'resource-requests'] as const,
  suggestions: (id: string) => [...portfolioKeys.all, 'suggestions', id] as const,
  profiles: () => [...portfolioKeys.all, 'profiles'] as const,
  requests: () => [...portfolioKeys.all, 'requests'] as const,
  requestList: (query: ListProjectRequestsQuery) => [...portfolioKeys.requests(), 'list', query] as const,
  request: (id: string) => [...portfolioKeys.requests(), 'detail', id] as const,
  funnel: () => [...portfolioKeys.all, 'funnel'] as const,
  roadmap: (query: RoadmapQuery) => [...portfolioKeys.all, 'roadmap', query] as const,
  settings: () => [...portfolioKeys.all, 'settings'] as const,
};

function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 3;
}

// ── Queries ─────────────────────────────────────────────────────────────────

export function useCapacity(query: CapacityQuery) {
  const { flowPortfolio } = useAppApi();
  return useQuery({
    queryKey: portfolioKeys.capacity(query),
    queryFn: async () => (await flowPortfolio.getCapacity(query)).data,
    retry: retryUnlessClientError,
  });
}

export function useResourceRequests(status?: 'open' | 'booked' | 'cancelled') {
  const { flowPortfolio } = useAppApi();
  return useQuery({
    queryKey: [...portfolioKeys.resourceRequests(), status ?? 'all'] as const,
    queryFn: async () => (await flowPortfolio.listResourceRequests({ status, limit: 100 })).data,
    retry: retryUnlessClientError,
  });
}

export function useSuggestions(id: string | null) {
  const { flowPortfolio } = useAppApi();
  return useQuery({
    queryKey: portfolioKeys.suggestions(id ?? ''),
    queryFn: async () => (await flowPortfolio.getSuggestions(id as string)).data,
    enabled: !!id,
    retry: retryUnlessClientError,
  });
}

export function useMemberProfile(memberId: string | null) {
  const { flowPortfolio } = useAppApi();
  return useQuery({
    queryKey: [...portfolioKeys.profiles(), memberId ?? ''] as const,
    queryFn: async () => (await flowPortfolio.getProfile(memberId as string)).data,
    enabled: !!memberId,
    retry: retryUnlessClientError,
  });
}

export function useProjectRequests(query: ListProjectRequestsQuery = {}) {
  const { flowPortfolio } = useAppApi();
  return useQuery({
    queryKey: portfolioKeys.requestList(query),
    queryFn: async (): Promise<ProjectRequest[]> => (await flowPortfolio.listProjectRequests({ limit: 200, ...query })).data,
    retry: retryUnlessClientError,
  });
}

export function useProjectRequest(id: string | null) {
  const { flowPortfolio } = useAppApi();
  return useQuery({
    queryKey: portfolioKeys.request(id ?? ''),
    queryFn: async () => (await flowPortfolio.getProjectRequest(id as string)).data,
    enabled: !!id,
    retry: retryUnlessClientError,
  });
}

export function useIntakeFunnel() {
  const { flowPortfolio } = useAppApi();
  return useQuery({
    queryKey: portfolioKeys.funnel(),
    queryFn: async () => (await flowPortfolio.getIntakeFunnel()).data,
    retry: retryUnlessClientError,
  });
}

export function useRoadmap(query: RoadmapQuery) {
  const { flowPortfolio } = useAppApi();
  return useQuery({
    queryKey: portfolioKeys.roadmap(query),
    queryFn: async () => (await flowPortfolio.getRoadmap(query)).data,
    retry: retryUnlessClientError,
  });
}

export function useIntakeSettings() {
  const { flowPortfolio } = useAppApi();
  return useQuery({
    queryKey: portfolioKeys.settings(),
    queryFn: async () => (await flowPortfolio.getIntakeSettings()).data,
    retry: retryUnlessClientError,
  });
}

/** Names of the workspace's members by user id, for the heatmap and the board. */
export function useMemberNames() {
  const { data } = useAllTeamMembers({});
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const member of data ?? []) names.set(member.userId, member.name || member.userId);
    return { nameOf: (id: string) => names.get(id) ?? id, options: [...names].map(([value, label]) => ({ value, label })) };
  }, [data]);
}

// ── Mutations ───────────────────────────────────────────────────────────────

/** A mutation that refreshes every portfolio query when it succeeds. */
function usePortfolioMutation<TVariables, TResult>(run: (variables: TVariables) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: portfolioKeys.all });
    },
  });
}

export function useCreateBooking() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation((input: CreateBookingInput) => flowPortfolio.createBooking(input));
}

export function useUpdateBooking() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation(({ id, input }: { id: string; input: UpdateBookingInput }) =>
    flowPortfolio.updateBooking(id, input),
  );
}

export function useDeleteBooking() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation((id: string) => flowPortfolio.deleteBooking(id));
}

export function useCreateResourceRequest() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation((input: CreateResourceRequestInput) => flowPortfolio.createResourceRequest(input));
}

export function useUpdateResourceRequest() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation(({ id, input }: { id: string; input: UpdateResourceRequestInput }) =>
    flowPortfolio.updateResourceRequest(id, input),
  );
}

export function useBookResourceRequest() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation(({ id, input }: { id: string; input: BookResourceRequestInput }) =>
    flowPortfolio.bookResourceRequest(id, input),
  );
}

export function useSaveMemberProfile() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation(({ memberId, input }: { memberId: string; input: UpdateMemberProfileInput }) =>
    flowPortfolio.saveProfile(memberId, input),
  );
}

export function useCreateProjectRequest() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation((input: CreateProjectRequestInput) => flowPortfolio.createProjectRequest(input));
}

export function useUpdateProjectRequest() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation(({ id, input }: { id: string; input: UpdateProjectRequestInput }) =>
    flowPortfolio.updateProjectRequest(id, input),
  );
}

export function useDeleteProjectRequest() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation((id: string) => flowPortfolio.deleteProjectRequest(id));
}

export function useScoreProjectRequest() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation(({ id, input }: { id: string; input: ScoreProjectRequestInput }) =>
    flowPortfolio.scoreProjectRequest(id, input),
  );
}

export function useSubmitProjectRequest() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation((id: string) => flowPortfolio.submitProjectRequest(id));
}

export function useConvertProjectRequest() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation(({ id, input }: { id: string; input: ConvertProjectRequestInput }) =>
    flowPortfolio.convertProjectRequest(id, input),
  );
}

export function useSaveIntakeSettings() {
  const { flowPortfolio } = useAppApi();
  return usePortfolioMutation((input: UpdateFlowSettingsInput) => flowPortfolio.saveIntakeSettings(input));
}
