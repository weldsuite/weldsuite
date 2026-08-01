/**
 * WeldObjects — TanStack Query hooks.
 *
 * Two surfaces, mirroring the API:
 *   - definitions (`/custom-objects`) — the Settings object builder
 *   - records (`/objects/:slug/records`) — the runtime list/detail pages
 *
 * There is deliberately no field-definition hook here. A custom object's fields
 * ARE `custom_field_definitions` rows, so `useCustomFields('co_<slug>')` from
 * hooks/use-custom-fields.ts already covers them.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CustomObjectStatus = 'draft' | 'active' | 'disabled';

export interface CustomObject {
  id: string;
  slug: string;
  entityKey: string;
  labelSingular: string;
  labelPlural: string;
  description: string | null;
  icon: string;
  color: string | null;
  status: CustomObjectStatus;
  titleFieldId: string | null;
  enableEvents: boolean;
  enableSearch: boolean;
  enableAgentTools: boolean;
  enableExternalApi: boolean;
  listConfig: { columns?: string[]; defaultSort?: { key: string; direction: 'asc' | 'desc' } };
  sortOrder: number;
  recordCount?: number;
  fieldCount?: number;
}

export interface CustomObjectRecord {
  id: string;
  objectId: string;
  entityKey: string;
  title: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  fields: Record<string, unknown>;
}

export interface CustomObjectLink {
  id: string;
  slug: string;
  sourceEntityKey: string;
  targetEntityKey: string;
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  sourceLabel: string;
  targetLabel: string;
  onDelete: 'restrict' | 'cascade' | 'set_null';
  required: boolean;
  sortOrder: number;
}

export interface RelatedEntry {
  id: string;
  entityType: string;
  title: string;
  href: string;
  relationId: string;
}

export interface RelatedPanel {
  linkId: string;
  linkSlug: string;
  label: string;
  cardinality: CustomObjectLink['cardinality'];
  targetEntityKey: string;
  records: RelatedEntry[];
}

export interface ReversePanel {
  linkId: string;
  linkSlug: string;
  label: string;
  objectSlug: string;
  objectLabelPlural: string;
  records: Array<{ id: string; title: string; href: string; relationId: string }>;
}

export interface DeleteImpact {
  recordCount: number;
  fieldCount: number;
  linkCount: number;
  relationCount: number;
}

export interface LinkTarget {
  entityType: string;
  label: string;
  kind: 'builtin' | 'custom';
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const customObjectKeys = {
  all: ['custom-objects'] as const,
  list: () => [...customObjectKeys.all, 'list'] as const,
  detail: (id: string) => [...customObjectKeys.all, 'detail', id] as const,
  deleteImpact: (id: string) => [...customObjectKeys.all, 'delete-impact', id] as const,
  links: (id: string) => [...customObjectKeys.all, 'links', id] as const,
  linkTargets: () => [...customObjectKeys.all, 'link-targets'] as const,
  records: (slug: string) => [...customObjectKeys.all, 'records', slug] as const,
  recordList: (slug: string, params: unknown) =>
    [...customObjectKeys.records(slug), 'list', params] as const,
  record: (slug: string, id: string) => [...customObjectKeys.records(slug), id] as const,
  recordLinks: (slug: string, id: string) =>
    [...customObjectKeys.records(slug), id, 'links'] as const,
  reverse: (entityType: string, entityId: string) =>
    [...customObjectKeys.all, 'reverse', entityType, entityId] as const,
  /** Prefix covering every reverse panel — a link change on one record can
   *  affect a panel on any target, and the mutation doesn't know which. */
  reverseAll: () => [...customObjectKeys.all, 'reverse'] as const,
};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * Every custom object in the workspace.
 *
 * Used by the Settings list AND the sidebar, so it is intentionally one query
 * rather than two — the sidebar renders on every page, and a second endpoint
 * would double that cost for the same rows.
 */
export function useCustomObjects(options: { status?: CustomObjectStatus } = {}) {
  const { getClient } = useAppApiClient();
  const { status } = options;

  return useQuery({
    queryKey: [...customObjectKeys.list(), status ?? 'all'],
    queryFn: async () => {
      const client = await getClient();
      const query = status ? `?status=${encodeURIComponent(status)}` : '';
      // The endpoint returns the list envelope (`{ data, pagination }`); only
      // `data` matters here since object definitions are never paginated.
      const res = await client.get<{ data: CustomObject[] }>(`/custom-objects${query}`);
      return res.data ?? [];
    },
  });
}

export function useCustomObject(id: string | undefined) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: customObjectKeys.detail(id ?? ''),
    enabled: !!id,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: CustomObject }>(`/custom-objects/${id}`);
      return res.data;
    },
  });
}

/** Resolve a slug to its object from the cached list — avoids a second fetch. */
export function useCustomObjectBySlug(slug: string | undefined) {
  const { data: objects, isLoading } = useCustomObjects();
  return {
    data: slug ? objects?.find((o) => o.slug === slug) : undefined,
    isLoading,
  };
}

export function useCreateCustomObject() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      const client = await getClient();
      const res = await client.post<{ data: CustomObject }>('/custom-objects', input);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customObjectKeys.all });
    },
  });
}

export function useUpdateCustomObject() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...input }: { id: string } & Record<string, unknown>) => {
      const client = await getClient();
      const res = await client.put<{ data: CustomObject }>(`/custom-objects/${id}`, input);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customObjectKeys.all });
    },
  });
}

export function useCustomObjectDeleteImpact(id: string | undefined, enabled = true) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: customObjectKeys.deleteImpact(id ?? ''),
    enabled: !!id && enabled,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeleteImpact }>(`/custom-objects/${id}/delete-impact`);
      return res.data;
    },
  });
}

/**
 * Delete an object type.
 *
 * `confirm` must equal the object's slug — the API refuses otherwise. That is
 * not ceremony: this destroys every record, field and relationship the object
 * owns, and a mis-wired button should not be able to do that.
 */
export function useDeleteCustomObject() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, slug }: { id: string; slug: string }) => {
      const client = await getClient();
      await client.delete(`/custom-objects/${id}?confirm=${encodeURIComponent(slug)}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customObjectKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function useCustomObjectLinks(objectId: string | undefined) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: customObjectKeys.links(objectId ?? ''),
    enabled: !!objectId,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: CustomObjectLink[] }>(
        `/custom-objects/${objectId}/links`,
      );
      return res.data ?? [];
    },
  });
}

export function useLinkTargets() {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: customObjectKeys.linkTargets(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: LinkTarget[] }>('/custom-objects/link-targets');
      return res.data ?? [];
    },
  });
}

export function useCreateCustomObjectLink() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ objectId, ...input }: { objectId: string } & Record<string, unknown>) => {
      const client = await getClient();
      const res = await client.post<{ data: CustomObjectLink }>(
        `/custom-objects/${objectId}/links`,
        input,
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: customObjectKeys.links(variables.objectId) });
    },
  });
}

export function useDeleteCustomObjectLink() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ objectId, linkId }: { objectId: string; linkId: string }) => {
      const client = await getClient();
      await client.delete(`/custom-objects/${objectId}/links/${linkId}`);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: customObjectKeys.links(variables.objectId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface RecordListParams {
  limit?: number;
  cursor?: string;
  search?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
  filters?: Record<string, string>;
}

export interface RecordListResult {
  data: CustomObjectRecord[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

export function useCustomObjectRecords(slug: string | undefined, params: RecordListParams = {}) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: customObjectKeys.recordList(slug ?? '', params),
    enabled: !!slug,
    queryFn: async () => {
      const client = await getClient();
      const query = new URLSearchParams();
      if (params.limit) query.set('limit', String(params.limit));
      if (params.cursor) query.set('cursor', params.cursor);
      if (params.search) query.set('search', params.search);
      if (params.sort) query.set('sort', params.sort);
      if (params.direction) query.set('direction', params.direction);
      // Custom-field filters travel as `filter[custom:<slug>]=value`, matching
      // the bracket syntax the route parses out of the raw query string.
      for (const [key, value] of Object.entries(params.filters ?? {})) {
        query.set(`filter[${key}]`, value);
      }
      const qs = query.toString();
      return client.get<RecordListResult>(
        `/objects/${slug}/records${qs ? `?${qs}` : ''}`,
      );
    },
  });
}

export function useCustomObjectRecord(slug: string | undefined, id: string | undefined) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: customObjectKeys.record(slug ?? '', id ?? ''),
    enabled: !!slug && !!id,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: CustomObjectRecord }>(
        `/objects/${slug}/records/${id}`,
      );
      return res.data;
    },
  });
}

export function useCreateCustomObjectRecord(slug: string) {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { fields?: Record<string, unknown>; ownerId?: string | null }) => {
      const client = await getClient();
      const res = await client.post<{ data: CustomObjectRecord }>(
        `/objects/${slug}/records`,
        input,
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customObjectKeys.records(slug) });
    },
  });
}

export function useUpdateCustomObjectRecord(slug: string) {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      ...input
    }: { id: string; fields?: Record<string, unknown>; ownerId?: string | null }) => {
      const client = await getClient();
      const res = await client.patch<{ data: CustomObjectRecord }>(
        `/objects/${slug}/records/${id}`,
        input,
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customObjectKeys.records(slug) });
    },
  });
}

export function useDeleteCustomObjectRecord(slug: string) {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete(`/objects/${slug}/records/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customObjectKeys.records(slug) });
      // A deleted record drops out of every reverse panel that listed it.
      queryClient.invalidateQueries({ queryKey: customObjectKeys.reverseAll() });
    },
  });
}

// ---------------------------------------------------------------------------
// Related records
// ---------------------------------------------------------------------------

export function useRecordRelatedPanels(slug: string | undefined, recordId: string | undefined) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: customObjectKeys.recordLinks(slug ?? '', recordId ?? ''),
    enabled: !!slug && !!recordId,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: RelatedPanel[] }>(
        `/objects/${slug}/records/${recordId}/links`,
      );
      return res.data ?? [];
    },
  });
}

export function useAttachRelated(slug: string) {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      recordId,
      linkSlug,
      targetId,
    }: { recordId: string; linkSlug: string; targetId: string }) => {
      const client = await getClient();
      await client.post(`/objects/${slug}/records/${recordId}/links/${linkSlug}/${targetId}`, {});
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: customObjectKeys.recordLinks(slug, variables.recordId),
      });
      // The TARGET's reverse panel now lists a different set of records, and it
      // lives on a different page (the Customer or Person detail view) that has
      // no other reason to refetch — without this it shows stale links.
      queryClient.invalidateQueries({ queryKey: customObjectKeys.reverseAll() });
    },
  });
}

export function useDetachRelated(slug: string) {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      recordId,
      linkSlug,
      targetId,
    }: { recordId: string; linkSlug: string; targetId: string }) => {
      const client = await getClient();
      await client.delete(`/objects/${slug}/records/${recordId}/links/${linkSlug}/${targetId}`);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: customObjectKeys.recordLinks(slug, variables.recordId),
      });
      // The TARGET's reverse panel now lists a different set of records, and it
      // lives on a different page (the Customer or Person detail view) that has
      // no other reason to refetch — without this it shows stale links.
      queryClient.invalidateQueries({ queryKey: customObjectKeys.reverseAll() });
    },
  });
}

/**
 * Custom object records linked to ANY record — the panel a Customer or Person
 * detail page renders without knowing custom objects exist.
 */
export function useReverseRelatedPanels(
  entityType: string | undefined,
  entityId: string | undefined,
) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: customObjectKeys.reverse(entityType ?? '', entityId ?? ''),
    enabled: !!entityType && !!entityId,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: ReversePanel[] }>(
        `/related/${entityType}/${entityId}/custom-objects`,
      );
      return res.data ?? [];
    },
  });
}
