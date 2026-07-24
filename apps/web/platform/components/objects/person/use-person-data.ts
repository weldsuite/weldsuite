/**
 * Colocated data hooks for the person object panel.
 *
 * Self-contained: every read/write hook talks to `apps/workers/app-api` directly
 * (no core-api, no api-worker). Re-exported from
 * `apps/web/platform/hooks/queries/use-people-queries.ts` for legacy callers.
 */

import { useCallback } from 'react';
import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { buildQueryString } from '@weldsuite/api-client';
import type {
  Person,
  CreatePersonInput,
  UpdatePersonInput,
  ListPeopleQuery,
  ImportPersonRecord,
  ImportResult as PersonImportResult,
  ExportPeopleQuery,
} from '@weldsuite/core-api-client/schemas/people';

export type { Person, CreatePersonInput, UpdatePersonInput, ListPeopleQuery };
export type { ImportPersonRecord, PersonImportResult, ExportPeopleQuery };

interface PaginationMeta {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

interface DataEnvelope<T> {
  data: T;
}

interface ListEnvelope<T> {
  data: T[];
  pagination: PaginationMeta;
}

interface EntityChannel {
  id: string;
  name: string;
  slug: string;
  type: 'entity';
  entityType: string;
  entityId: string;
  entityDisplayName: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  messageCount: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

interface SendMessageInput {
  content: string;
  htmlContent?: string;
  parentId?: string;
  mentions?: string[];
  mentionsEveryone?: boolean;
  attachments?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export const personKeys = {
  all: ['people'] as const,
  lists: () => [...personKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...personKeys.lists(), filters] as const,
  details: () => [...personKeys.all, 'detail'] as const,
  detail: (id: string) => [...personKeys.details(), id] as const,
  detailFull: (id: string, options?: Record<string, unknown>) => [...personKeys.details(), id, 'full', options] as const,
  navigation: (id: string, listId?: string) => [...personKeys.all, 'navigation', id, listId] as const,
  companies: (id: string) => [...personKeys.all, id, 'companies'] as const,
  channel: (id: string) => [...personKeys.all, id, 'channel'] as const,
  byEmails: (emails: string[]) => [...personKeys.all, 'by-emails', emails.slice().sort().join(',')] as const,
  recentCorrespondents: (accountId?: string) => [...personKeys.all, 'recent-correspondents', accountId] as const,
};

// ───────────────────────────────────────────────────────────────────────────
// Live sync — subscribe to `person` topic on WorkspaceHub and reconcile the
// TanStack Query cache so every screen showing people stays in step with
// what other users do. Mirrors `useCompanyLiveSync()`.
//
// Called automatically from `usePeople()` / `useInfinitePeople()` /
// `usePerson()`. Multiple subscribers to the same topic dedupe inside
// `WorkspaceClient`, so over-subscription is safe.
// ───────────────────────────────────────────────────────────────────────────

type PersonRealtimePayload = Partial<Person> & { id: string };

function patchPersonListsInPlace(
  qc: ReturnType<typeof useQueryClient>,
  id: string,
  patch: (p: Person) => Person | null,
): void {
  qc.setQueriesData<ListEnvelope<Person>>({ queryKey: personKeys.lists() }, (prev) => {
    if (!prev?.data) return prev;
    const next: Person[] = [];
    for (const p of prev.data) {
      if (p.id === id) {
        const updated = patch(p);
        if (updated) next.push(updated);
      } else {
        next.push(p);
      }
    }
    return { ...prev, data: next };
  });

  qc.setQueriesData<{ pages: ListEnvelope<Person>[]; pageParams: unknown[] }>(
    { queryKey: [...personKeys.lists(), 'infinite'] },
    (prev) => {
      if (!prev?.pages) return prev;
      return {
        ...prev,
        pages: prev.pages.map((page) => {
          const data: Person[] = [];
          for (const p of page.data) {
            if (p.id === id) {
              const updated = patch(p);
              if (updated) data.push(updated);
            } else {
              data.push(p);
            }
          }
          return { ...page, data };
        }),
      };
    },
  );
}

function usePersonLiveSync(): void {
  const qc = useQueryClient();

  const handler = useCallback(
    (event: { event: string; data: PersonRealtimePayload }) => {
      const payload = event.data;
      const id = payload?.id;
      const action = event.event;

      if (action === 'created') {
        qc.invalidateQueries({ queryKey: personKeys.lists() });
        return;
      }

      if (!id) return;

      if (action === 'updated' || action === 'archived' || action === 'unarchived') {
        patchPersonListsInPlace(qc, id, (p) => ({ ...p, ...payload } as Person));
        qc.setQueryData<DataEnvelope<Person>>(personKeys.detail(id), (prev) =>
          prev ? { ...prev, data: { ...prev.data, ...payload } as Person } : prev,
        );
        return;
      }

      if (action === 'deleted') {
        patchPersonListsInPlace(qc, id, () => null);
        qc.removeQueries({ queryKey: personKeys.detail(id) });
        qc.invalidateQueries({ queryKey: personKeys.companies(id) });
      }
    },
    [qc],
  );

  useTopic<PersonRealtimePayload>('person', handler);
}

export function usePeople(filters?: ListPeopleQuery) {
  const { getClient } = useAppApiClient();
  usePersonLiveSync();
  return useQuery({
    queryKey: personKeys.list(filters as Record<string, unknown> | undefined),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListEnvelope<Person>>(
        `/people${buildQueryString((filters ?? {}) as Record<string, unknown>)}`,
      );
    },
  });
}

export function useInfinitePeople(filters?: Omit<ListPeopleQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  usePersonLiveSync();
  return useInfiniteQuery({
    queryKey: [...personKeys.lists(), 'infinite', filters],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      return client.get<ListEnvelope<Person>>(
        `/people${buildQueryString({
          ...(filters ?? {}),
          cursor: pageParam as string | undefined,
        } as Record<string, unknown>)}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.cursor ?? undefined : undefined,
  });
}

export function usePerson(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  usePersonLiveSync();
  return useQuery({
    queryKey: personKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<Person>>(`/people/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export interface PersonCompanyRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  personId: string;
  companyId: string;
  role?: string | null;
  isPrimary?: boolean | null;
  startedAt?: string | null;
  endedAt?: string | null;
  company: {
    id: string;
    displayName: string;
    name?: string | null;
    industry?: string | null;
    avatarUrl?: string | null;
  } | null;
}

export function usePersonCompanies(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: personKeys.companies(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<PersonCompanyRow[]>>(`/people/${id}/companies`);
    },
    enabled: !!id && enabled,
  });
}

export function useCreatePerson() {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreatePersonInput) => {
      const client = await getClient();
      return client.post<DataEnvelope<Person>>(`/people`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: personKeys.lists() });
    },
    onError: (err) => {
      console.error('[People] create failed:', err);
      toast.error(t('sweep.entities.createPersonFailed'));
    },
  });
}

export function useUpdatePerson() {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdatePersonInput }) => {
      const client = await getClient();
      return client.patch<DataEnvelope<Person>>(`/people/${id}`, data);
    },
    onSuccess: (result, variables) => {
      const updated = result?.data;
      qc.setQueriesData<ListEnvelope<Person>>({ queryKey: personKeys.lists() }, (prev) => {
        if (!prev?.data) return prev;
        const next = prev.data.map((p) =>
          p.id === variables.id ? ({ ...p, ...(updated ?? variables.data) } as Person) : p,
        );
        return { ...prev, data: next };
      });
      qc.setQueriesData<{ pages: ListEnvelope<Person>[]; pageParams: unknown[] }>(
        { queryKey: [...personKeys.lists(), 'infinite'] },
        (prev) => {
          if (!prev?.pages) return prev;
          return {
            ...prev,
            pages: prev.pages.map((page) => ({
              ...page,
              data: page.data.map((p) =>
                p.id === variables.id ? ({ ...p, ...(updated ?? variables.data) } as Person) : p,
              ),
            })),
          };
        },
      );
      qc.invalidateQueries({ queryKey: personKeys.detail(variables.id) });
    },
    onError: (err) => {
      console.error('[People] update failed:', err);
      toast.error(t('sweep.entities.updatePersonFailed'));
    },
  });
}

export function useDeletePerson() {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/people/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: personKeys.all });
    },
    onError: (err) => {
      console.error('[People] delete failed:', err);
      toast.error(t('sweep.entities.deletePersonFailed'));
    },
  });
}

/**
 * Promote a mail-only person into the CRM (flips `inCrm` to true).
 * Backs the "Add to CRM" button on the person panel. Updates the cached
 * person detail so the button disappears immediately, then invalidates the
 * people lists so the CRM grid picks the new member up.
 */
export function useAddPersonToCrm() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<DataEnvelope<Person>>(`/people/${id}/add-to-crm`, {});
    },
    onSuccess: (result, id) => {
      const updated = result?.data;
      qc.setQueryData<DataEnvelope<Person>>(personKeys.detail(id), (prev) =>
        prev ? { ...prev, data: { ...prev.data, ...(updated ?? { inCrm: true }) } } : prev,
      );
      qc.invalidateQueries({ queryKey: personKeys.lists() });
    },
    onError: (err) => {
      console.error('[People] add-to-crm failed:', err);
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Mail recipient resolver hooks.
//
// These three hooks back WeldMail's "To" field autocomplete + avatar hydration
// without introducing a "contact" concept — recipients ARE people.

/**
 * Minimal person summary returned by the resolver endpoints.
 * Matches the `PersonSummary` shape from `services/people.ts`.
 */
export interface PersonSummary {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

interface PersonSummaryEnvelope {
  data: PersonSummary[];
}

/**
 * Search people by name OR email. Backs the mail "To" field autocomplete.
 * The search hits `GET /people?search=<q>` which already matches email
 * via ilike (confirmed in `listPeople`). Disabled when `query` is empty.
 */
export function usePersonSearch(query: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: personKeys.list({ search: query, limit: 20 }),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListEnvelope<Person>>(
        `/people${buildQueryString({ search: query, limit: 20 } as Record<string, unknown>)}`,
      );
    },
    enabled: enabled && query.trim().length > 0,
  });
}

/**
 * Return recently-touched people for mail recipient suggestions.
 * Hits `GET /people/recent-correspondents?accountId=<id>&limit=<n>`.
 */
export function useRecentCorrespondents(accountId?: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: personKeys.recentCorrespondents(accountId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<PersonSummary[]>>(
        `/people/recent-correspondents${buildQueryString({ accountId, limit: 20 } as Record<string, unknown>)}`,
      );
    },
    enabled,
  });
}

/**
 * Resolve a list of raw email addresses to their Person rows.
 * Used to hydrate avatars + person links in the mail thread view.
 * Hits `POST /people/resolve-by-emails`.
 * Disabled when `emails` is empty.
 */
export function usePeopleByEmails(emails: string[], enabled = true) {
  const { getClient } = useAppApiClient();
  const stableKey = personKeys.byEmails(emails);
  return useQuery({
    queryKey: stableKey,
    queryFn: async () => {
      const client = await getClient();
      return client.post<PersonSummaryEnvelope>(`/people/resolve-by-emails`, { emails });
    },
    enabled: enabled && emails.length > 0,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Import / export — upsert a batch of people (matched by partyCode/email) and
// pull every row matching the current filters for client-side CSV/XLSX.

export function useImportPeople() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (records: ImportPersonRecord[]): Promise<PersonImportResult> => {
      const client = await getClient();
      const res = await client.post<DataEnvelope<PersonImportResult>>(`/people/import`, {
        records,
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: personKeys.lists() });
    },
  });
}

export function useExportPeople() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (filter: ExportPeopleQuery): Promise<Person[]> => {
      const client = await getClient();
      const res = await client.get<DataEnvelope<Person[]>>(
        `/people/export${buildQueryString((filter ?? {}) as Record<string, unknown>)}`,
      );
      return res.data;
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Chat sidebar.

export function usePersonChannel(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: personKeys.channel(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<EntityChannel | null>>(`/people/${id}/chat/channel`);
    },
    enabled: !!id && enabled,
    retry: false,
  });
}

export function useSendPersonMessage(id: string) {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (input: SendMessageInput) => {
      const client = await getClient();
      return client.post<
        DataEnvelope<{ channel: EntityChannel; message: unknown; createdChannel: boolean }>
      >(`/people/${id}/chat/messages`, input);
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Detail aggregate, navigation, bulk-update — wired to the Phase 3
// capability endpoints on `/api/people`. Mirror of the company hooks.

export interface PersonDetailOptions {
  activitiesLimit?: number;
  ticketsLimit?: number;
  companiesLimit?: number;
}

export function usePersonDetail(
  id: string,
  options?: PersonDetailOptions,
  enabled = true,
) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: personKeys.detailFull(id, options as Record<string, unknown> | undefined),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<unknown>>(
        `/people/${id}/detail${buildQueryString((options ?? {}) as Record<string, unknown>)}`,
      );
    },
    enabled: !!id && enabled,
  });
}

export function usePersonNavigation(id: string, listId?: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: personKeys.navigation(id, listId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<{
        currentIndex: number;
        totalCount: number;
        previousId: string | null;
        nextId: string | null;
        contextName: string;
      }>>(`/people/${id}/navigation${buildQueryString({ listId })}`);
    },
    enabled: !!id && enabled,
  });
}

