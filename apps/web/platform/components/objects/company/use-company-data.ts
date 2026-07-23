/**
 * Colocated data hooks for the company object panel.
 *
 * Self-contained: every read/write hook talks to `apps/workers/app-api` directly
 * (no core-api, no api-worker). Adding a new field, mutation, or chat
 * action means editing this file — no other surface needs touching.
 *
 * Re-exported from `apps/web/platform/hooks/queries/use-companies-queries.ts`
 * for legacy callers (the CRM grid, customer detail page, etc.). Once
 * those switch to importing here directly the shim can be removed.
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
  Company,
  CreateCompanyInput,
  UpdateCompanyInput,
  ListCompaniesQuery,
} from '@weldsuite/app-api-client/schemas/companies';
import type {
  ImportCompanyRecord,
  ImportResult as CompanyImportResult,
  ExportCompaniesQuery,
} from '@weldsuite/app-api-client/schemas/companies';

export type { Company, CreateCompanyInput, UpdateCompanyInput, ListCompaniesQuery };
export type { ImportCompanyRecord, CompanyImportResult, ExportCompaniesQuery };

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

export const companyKeys = {
  all: ['companies'] as const,
  lists: () => [...companyKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...companyKeys.lists(), filters] as const,
  details: () => [...companyKeys.all, 'detail'] as const,
  detail: (id: string) => [...companyKeys.details(), id] as const,
  detailFull: (id: string, options?: Record<string, unknown>) => [...companyKeys.details(), id, 'full', options] as const,
  navigation: (id: string, listId?: string) => [...companyKeys.all, 'navigation', id, listId] as const,
  people: (id: string) => [...companyKeys.all, id, 'people'] as const,
  channel: (id: string) => [...companyKeys.all, id, 'channel'] as const,
};

// ───────────────────────────────────────────────────────────────────────────
// Live sync — subscribe to `company` topic on WorkspaceHub and reconcile the
// TanStack Query cache so every screen showing companies stays in step with
// what other users do.
//
// Called automatically from `useCompanies()` / `useInfiniteCompanies()` /
// `useCompany()`. Multiple subscribers to the same topic dedupe inside
// `WorkspaceClient`, so over-subscription is safe.
// ───────────────────────────────────────────────────────────────────────────

type CompanyRealtimePayload = Partial<Company> & { id: string };

function patchListsInPlace(
  qc: ReturnType<typeof useQueryClient>,
  id: string,
  patch: (c: Company) => Company | null,
): void {
  qc.setQueriesData<ListEnvelope<Company>>({ queryKey: companyKeys.lists() }, (prev) => {
    if (!prev?.data) return prev;
    const next: Company[] = [];
    for (const c of prev.data) {
      if (c.id === id) {
        const updated = patch(c);
        if (updated) next.push(updated);
        // when patch returns null (delete), the row is dropped
      } else {
        next.push(c);
      }
    }
    return { ...prev, data: next };
  });

  qc.setQueriesData<{ pages: ListEnvelope<Company>[]; pageParams: unknown[] }>(
    { queryKey: [...companyKeys.lists(), 'infinite'] },
    (prev) => {
      if (!prev?.pages) return prev;
      return {
        ...prev,
        pages: prev.pages.map((page) => {
          const data: Company[] = [];
          for (const c of page.data) {
            if (c.id === id) {
              const updated = patch(c);
              if (updated) data.push(updated);
            } else {
              data.push(c);
            }
          }
          return { ...page, data };
        }),
      };
    },
  );
}

function useCompanyLiveSync(): void {
  const qc = useQueryClient();

  const handler = useCallback(
    (event: { event: string; data: CompanyRealtimePayload }) => {
      const payload = event.data;
      const id = payload?.id;
      const action = event.event;

      if (action === 'created') {
        // New row — refetch lists so cursor pagination stays correct.
        qc.invalidateQueries({ queryKey: companyKeys.lists() });
        return;
      }

      if (!id) return;

      if (action === 'updated' || action === 'archived' || action === 'unarchived') {
        patchListsInPlace(qc, id, (c) => ({ ...c, ...payload } as Company));
        qc.setQueryData<DataEnvelope<Company>>(companyKeys.detail(id), (prev) =>
          prev ? { ...prev, data: { ...prev.data, ...payload } as Company } : prev,
        );
        return;
      }

      if (action === 'deleted') {
        patchListsInPlace(qc, id, () => null);
        qc.removeQueries({ queryKey: companyKeys.detail(id) });
        qc.invalidateQueries({ queryKey: companyKeys.people(id) });
      }
    },
    [qc],
  );

  useTopic<CompanyRealtimePayload>('company', handler);
}

export function useCompanies(filters?: ListCompaniesQuery) {
  const { getClient } = useAppApiClient();
  useCompanyLiveSync();
  return useQuery({
    queryKey: companyKeys.list(filters as Record<string, unknown> | undefined),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListEnvelope<Company>>(
        `/companies${buildQueryString((filters ?? {}) as Record<string, unknown>)}`,
      );
    },
  });
}

export function useInfiniteCompanies(filters?: Omit<ListCompaniesQuery, 'cursor'>) {
  const { getClient } = useAppApiClient();
  useCompanyLiveSync();
  return useInfiniteQuery({
    queryKey: [...companyKeys.lists(), 'infinite', filters],
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      return client.get<ListEnvelope<Company>>(
        `/companies${buildQueryString({
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

export function useCompany(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useCompanyLiveSync();
  return useQuery({
    queryKey: companyKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<Company>>(`/companies/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export interface CompanyPersonRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  personId: string;
  companyId: string;
  role?: string | null;
  isPrimary?: boolean | null;
  startedAt?: string | null;
  endedAt?: string | null;
  person: {
    id: string;
    displayName: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  } | null;
}

export function useCompanyPeople(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: companyKeys.people(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<CompanyPersonRow[]>>(`/companies/${id}/people`);
    },
    enabled: !!id && enabled,
  });
}

export function useCreateCompany() {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateCompanyInput) => {
      const client = await getClient();
      return client.post<DataEnvelope<Company>>(`/companies`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: companyKeys.lists() });
    },
    onError: (err) => {
      console.error('[Companies] create failed:', err);
      toast.error(t('sweep.entities.createCompanyFailed'));
    },
  });
}

export function useUpdateCompany() {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateCompanyInput }) => {
      const client = await getClient();
      return client.patch<DataEnvelope<Company>>(`/companies/${id}`, data);
    },
    onSuccess: (result, variables) => {
      const updated = result?.data;
      qc.setQueriesData<ListEnvelope<Company>>({ queryKey: companyKeys.lists() }, (prev) => {
        if (!prev?.data) return prev;
        const next = prev.data.map((c) =>
          c.id === variables.id ? ({ ...c, ...(updated ?? variables.data) } as Company) : c,
        );
        return { ...prev, data: next };
      });
      qc.setQueriesData<{ pages: ListEnvelope<Company>[]; pageParams: unknown[] }>(
        { queryKey: [...companyKeys.lists(), 'infinite'] },
        (prev) => {
          if (!prev?.pages) return prev;
          return {
            ...prev,
            pages: prev.pages.map((page) => ({
              ...page,
              data: page.data.map((c) =>
                c.id === variables.id ? ({ ...c, ...(updated ?? variables.data) } as Company) : c,
              ),
            })),
          };
        },
      );
      qc.invalidateQueries({ queryKey: companyKeys.detail(variables.id) });
    },
    onError: (err) => {
      console.error('[Companies] update failed:', err);
      toast.error(t('sweep.entities.updateCompanyFailed'));
    },
  });
}

export function useDeleteCompany() {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/companies/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: companyKeys.all });
    },
    onError: (err) => {
      console.error('[Companies] delete failed:', err);
      toast.error(t('sweep.entities.deleteCompanyFailed'));
    },
  });
}

export function useArchiveCompany() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<DataEnvelope<Company>>(`/companies/${id}/archive`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: companyKeys.all });
    },
  });
}

export function useUnarchiveCompany() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<DataEnvelope<Company>>(`/companies/${id}/unarchive`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: companyKeys.all });
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Import / export — upsert a batch of companies (matched by partyCode/email)
// and pull every row matching the current filters for client-side CSV/XLSX.

export function useImportCompanies() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (records: ImportCompanyRecord[]): Promise<CompanyImportResult> => {
      const client = await getClient();
      const res = await client.post<DataEnvelope<CompanyImportResult>>(`/companies/import`, {
        records,
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: companyKeys.lists() });
    },
  });
}

export function useExportCompanies() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (filter: ExportCompaniesQuery): Promise<Company[]> => {
      const client = await getClient();
      const res = await client.get<DataEnvelope<Company[]>>(
        `/companies/export${buildQueryString((filter ?? {}) as Record<string, unknown>)}`,
      );
      return res.data;
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Detail aggregate, navigation, bulk-update, refresh-logo — wired to the
// Phase 3 capability endpoints on `/api/companies`.

export interface CompanyDetailOptions {
  activitiesLimit?: number;
  ordersLimit?: number;
  opportunitiesLimit?: number;
  peopleLimit?: number;
}

export function useCompanyDetail(
  id: string,
  options?: CompanyDetailOptions,
  enabled = true,
) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: companyKeys.detailFull(id, options as Record<string, unknown> | undefined),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<unknown>>(
        `/companies/${id}/detail${buildQueryString((options ?? {}) as Record<string, unknown>)}`,
      );
    },
    enabled: !!id && enabled,
  });
}

export function useCompanyNavigation(id: string, listId?: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: companyKeys.navigation(id, listId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<{
        currentIndex: number;
        totalCount: number;
        previousId: string | null;
        nextId: string | null;
        contextName: string;
      }>>(`/companies/${id}/navigation${buildQueryString({ listId })}`);
    },
    enabled: !!id && enabled,
  });
}

function useBulkUpdateCompanies() {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      companyIds: string[];
      updates: {
        ownerId?: string | null;
        accountManagerId?: string | null;
        status?: string;
        lifecycleStage?: string;
      };
    }) => {
      const client = await getClient();
      return client.post<
        DataEnvelope<{ updated: number; failed: Array<{ id: string; reason: string }> }>
      >(`/companies/bulk-update`, input);
    },
    onSuccess: (_, variables) => {
      const ids = new Set(variables.companyIds);
      const patch = variables.updates;
      qc.setQueriesData<ListEnvelope<Company>>({ queryKey: companyKeys.lists() }, (prev) => {
        if (!prev?.data) return prev;
        return {
          ...prev,
          data: prev.data.map((c) => (ids.has(c.id) ? ({ ...c, ...patch } as Company) : c)),
        };
      });
      qc.setQueriesData<{ pages: ListEnvelope<Company>[]; pageParams: unknown[] }>(
        { queryKey: [...companyKeys.lists(), 'infinite'] },
        (prev) => {
          if (!prev?.pages) return prev;
          return {
            ...prev,
            pages: prev.pages.map((page) => ({
              ...page,
              data: page.data.map((c) => (ids.has(c.id) ? ({ ...c, ...patch } as Company) : c)),
            })),
          };
        },
      );
      for (const id of variables.companyIds) {
        qc.invalidateQueries({ queryKey: companyKeys.detail(id) });
        qc.invalidateQueries({ queryKey: companyKeys.detailFull(id) });
      }
    },
    onError: (err) => {
      console.error('[Companies] bulk-update failed:', err);
      toast.error(t('sweep.entities.bulkUpdateFailed'));
    },
  });
}

function useRefreshCompanyLogo() {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<DataEnvelope<Company>>(`/companies/${id}/refresh-logo`);
    },
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: companyKeys.detail(id) });
      qc.invalidateQueries({ queryKey: companyKeys.detailFull(id) });
      qc.invalidateQueries({ queryKey: companyKeys.lists() });
    },
    onError: (err) => {
      console.error('[Companies] refresh-logo failed:', err);
      toast.error(t('sweep.entities.refreshLogoFailed'));
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Chat sidebar — every panel folder owns its chat data path.

export function useCompanyChannel(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: companyKeys.channel(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataEnvelope<EntityChannel | null>>(
        `/companies/${id}/chat/channel`,
      );
    },
    enabled: !!id && enabled,
    retry: false,
  });
}

export function useSendCompanyMessage(id: string) {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (input: SendMessageInput) => {
      const client = await getClient();
      return client.post<
        DataEnvelope<{ channel: EntityChannel; message: unknown; createdChannel: boolean }>
      >(`/companies/${id}/chat/messages`, input);
    },
  });
}
