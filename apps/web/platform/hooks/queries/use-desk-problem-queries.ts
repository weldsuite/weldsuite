/**
 * WeldDesk problem management (desk-api `/api/desk/problems` and
 * `/api/desk/conversations/:id/problem`): the cause behind one or more
 * incidents (inbox conversations), with its root cause, workaround and
 * known-error status. The rules live in `@weldsuite/db/lib/desk-problems`; a
 * refusal answers 409 with `details.reason` (see `deskLinkRefusal`).
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { deskKeys, type DeskConversation, type DeskMessage, type DeskPriority } from './use-desk-queries';
import { deskLinkKeys, type DeskLinkSummary } from './use-desk-link-queries';

export type DeskProblemStatus = 'open' | 'investigating' | 'known_error' | 'resolved' | 'closed';
export const DESK_PROBLEM_STATUSES: DeskProblemStatus[] = ['open', 'investigating', 'known_error', 'resolved', 'closed'];
/** The statuses a problem that still needs work can have; a closed problem takes no new incidents. */
export const DESK_PROBLEM_LINKABLE_STATUSES: DeskProblemStatus[] = ['open', 'investigating', 'known_error', 'resolved'];

export interface DeskProblem {
  id: string;
  createdAt: string;
  updatedAt: string;
  problemNumber: number;
  title: string;
  description: string | null;
  status: DeskProblemStatus;
  priority: DeskPriority | null;
  rootCause: string | null;
  workaround: string | null;
  resolution: string | null;
  assigneeId: string | null;
  departmentId: string | null;
  articleId: string | null;
  knownErrorAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdById: string | null;
  incidentCount: number;
  openIncidentCount: number;
}

/** A problem as an incident's details panel shows it. */
export interface DeskProblemSummary {
  id: string;
  problemNumber: number;
  title: string;
  status: DeskProblemStatus;
  workaround: string | null;
  rootCause: string | null;
}

/** The list's tabs: which problems to show. */
export type DeskProblemView = 'open' | 'known_errors' | 'done' | 'all';

export interface DeskProblemFilters {
  view: DeskProblemView;
  q?: string;
}

export interface DeskProblemUpdate {
  title?: string;
  description?: string | null;
  status?: DeskProblemStatus;
  priority?: DeskPriority | null;
  assigneeId?: string | null;
  departmentId?: string | null;
  rootCause?: string | null;
  workaround?: string | null;
  resolution?: string | null;
}

export interface DeskProblemCreate {
  title: string;
  description?: string | null;
  priority?: DeskPriority | null;
  assigneeId?: string | null;
  departmentId?: string | null;
  rootCause?: string | null;
  workaround?: string | null;
  status?: DeskProblemStatus;
  conversationIds?: string[];
}

export type DeskProblemShareVisibility = 'note' | 'reply';

export const deskProblemKeys = {
  all: [...deskKeys.all, 'problems'] as const,
  lists: () => [...deskProblemKeys.all, 'list'] as const,
  list: (filters: DeskProblemFilters) => [...deskProblemKeys.lists(), filters] as const,
  detail: (id: string) => [...deskProblemKeys.all, 'detail', id] as const,
  incidents: (id: string) => [...deskProblemKeys.all, 'incidents', id] as const,
  conversations: () => [...deskProblemKeys.all, 'conversation'] as const,
  forConversation: (conversationId: string) => [...deskProblemKeys.conversations(), conversationId] as const,
  search: (q: string) => [...deskProblemKeys.all, 'search', q] as const,
};

const PAGE_SIZE = 50;

/** The query string a list tab sends. */
export function deskProblemQuery(filters: DeskProblemFilters, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filters.view === 'open') params.set('status', 'open,investigating,known_error');
  else if (filters.view === 'known_errors') params.set('knownErrors', '1');
  else if (filters.view === 'done') params.set('status', 'resolved,closed');
  const term = filters.q?.trim();
  if (term) params.set('q', term);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

interface ProblemPage {
  data: DeskProblem[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

export function useDeskProblems(filters: DeskProblemFilters) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: deskProblemKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      return client.get<ProblemPage>(`/desk/problems?${deskProblemQuery(filters, pageParam)}`);
    },
    getNextPageParam: (last) => (last.pagination.hasMore ? last.pagination.cursor ?? undefined : undefined),
  });
}

export function useDeskProblem(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskProblemKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskProblem }>(`/desk/problems/${encodeURIComponent(id)}`);
      return res.data;
    },
    enabled: !!id,
  });
}

/** The tickets linked to a problem. */
export function useDeskProblemIncidents(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskProblemKeys.incidents(id),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskLinkSummary[] }>(`/desk/problems/${encodeURIComponent(id)}/conversations?limit=200`);
      return res.data;
    },
    enabled: !!id,
  });
}

/** Problems an incident can be linked to: a search over the ones that still take incidents. */
export function useDeskProblemSearch(q: string, enabled = true) {
  const { getClient } = useAppApiClient();
  const term = q.trim();
  return useQuery({
    queryKey: deskProblemKeys.search(term),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ limit: '20', status: DESK_PROBLEM_LINKABLE_STATUSES.join(',') });
      if (term) params.set('q', term);
      const res = await client.get<{ data: DeskProblem[] }>(`/desk/problems?${params.toString()}`);
      return res.data;
    },
    enabled,
    staleTime: 10_000,
  });
}

/** The problem an incident is linked to, or null. */
export function useDeskConversationProblem(conversationId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskProblemKeys.forConversation(conversationId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskProblemSummary | null }>(`/desk/conversations/${conversationId}/problem`);
      return res.data;
    },
    enabled: !!conversationId,
  });
}

/** Everything a problem change can move: the problems, the incidents' threads and the inbox lists. */
function useRefreshAfterProblemChange() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: deskProblemKeys.all });
    void qc.invalidateQueries({ queryKey: deskLinkKeys.all });
    void qc.invalidateQueries({ queryKey: deskKeys.conversations() });
  };
}

export function useCreateDeskProblem() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterProblemChange();
  return useMutation({
    mutationFn: async (input: DeskProblemCreate) => {
      const client = await getClient();
      return client.post<{ data: { problem: DeskProblem; messages: DeskMessage[] } }>('/desk/problems', input);
    },
    onSuccess: refresh,
  });
}

export function useUpdateDeskProblem() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: DeskProblemUpdate }) => {
      const client = await getClient();
      return client.patch<{ data: DeskProblem }>(`/desk/problems/${encodeURIComponent(id)}`, patch);
    },
    onSuccess: (res, { id }) => {
      qc.setQueryData(deskProblemKeys.detail(id), res.data);
      void qc.invalidateQueries({ queryKey: deskProblemKeys.lists() });
      void qc.invalidateQueries({ queryKey: deskProblemKeys.conversations() });
    },
  });
}

export function useDeleteDeskProblem() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterProblemChange();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete(`/desk/problems/${encodeURIComponent(id)}`);
    },
    onSuccess: refresh,
  });
}

export function useShareDeskProblemWorkaround() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterProblemChange();
  return useMutation({
    mutationFn: async ({ id, body, visibility }: { id: string; body?: string; visibility: DeskProblemShareVisibility }) => {
      const client = await getClient();
      return client.post<{ data: { visibility: DeskProblemShareVisibility; delivered: number; skipped: number; conversationIds: string[] } }>(
        `/desk/problems/${encodeURIComponent(id)}/share-workaround`,
        { body, visibility },
      );
    },
    onSuccess: refresh,
  });
}

/** Write the draft help-center article from a problem. */
export function useCreateDeskProblemArticle() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<{ data: DeskProblem }>(`/desk/problems/${encodeURIComponent(id)}/article`);
    },
    onSuccess: (res, id) => {
      qc.setQueryData(deskProblemKeys.detail(id), res.data);
      void qc.invalidateQueries({ queryKey: deskProblemKeys.lists() });
    },
  });
}

type ProblemChange = {
  data: { conversation: DeskConversation; problem: DeskProblemSummary | null; messages: DeskMessage[] };
};

/** Link an incident to a problem, replace its problem, or unlink it (`problemId: null`). */
export function useSetDeskConversationProblem() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterProblemChange();
  return useMutation({
    mutationFn: async ({ id, problemId }: { id: string; problemId: string | null }) => {
      const client = await getClient();
      return client.put<ProblemChange>(`/desk/conversations/${id}/problem`, { problemId });
    },
    onSuccess: refresh,
  });
}
