/**
 * WeldKnow (knowledge base / wiki) query hooks — apps/workers/app-api `/api/knowledge/*`.
 *
 * Mirrors the shape of use-helpdesk-queries.ts: useAppApiClient() + getClient(),
 * a `knowledgeKeys` factory, and one hook per endpoint. Structural mutations
 * (create/delete/move/restore) invalidate the tree + spaces; metadata patches
 * also invalidate the page detail. The content autosave mutation intentionally
 * does NOT invalidate pageDetail — refetching mid-edit would clobber whatever
 * the BlockNote editor currently holds, so we just let the mutation resolve.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// Types — mirror packages/core/db/src/schema/knowledge-* + packages/clients/core-api-client/src/schemas/knowledge.ts
// =============================================================================

export type KnowledgeSpaceVisibility = 'workspace' | 'private';

export interface KnowledgeSpace {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  visibility: KnowledgeSpaceVisibility;
  sortOrder: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface KnowledgePageTreeNode {
  id: string;
  spaceId: string;
  parentId: string | null;
  position: number;
  title: string;
  icon: string | null;
  updatedAt: string;
}

export interface KnowledgePage {
  id: string;
  spaceId: string;
  parentId: string | null;
  position: number;
  title: string;
  contentJson: Record<string, unknown>[] | null;
  contentText: string | null;
  icon: string | null;
  coverImage: string | null;
  isLocked: boolean;
  createdBy: string | null;
  lastEditedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface KnowledgeTrashedPage {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  deletedAt: string;
}

export interface KnowledgePageVersionSummary {
  id: string;
  pageId: string;
  label: string | null;
  createdById: string | null;
  createdAt: string;
}

export interface KnowledgePageVersion extends KnowledgePageVersionSummary {
  content: Record<string, unknown>[];
}

export interface KnowledgeFavorite {
  id: string;
  pageId: string;
  position: number;
  title: string;
  icon: string | null;
  spaceId: string;
}

// =============================================================================
// Query Keys
// =============================================================================

const knowledgeKeys = {
  all: ['knowledge'] as const,

  spaces: () => [...knowledgeKeys.all, 'spaces'] as const,

  tree: (spaceId?: string) => [...knowledgeKeys.all, 'tree', spaceId ?? 'all'] as const,

  pages: () => [...knowledgeKeys.all, 'pages'] as const,
  pageDetail: (id: string) => [...knowledgeKeys.pages(), 'detail', id] as const,

  trash: () => [...knowledgeKeys.all, 'trash'] as const,

  favorites: () => [...knowledgeKeys.all, 'favorites'] as const,

  versions: (pageId: string) => [...knowledgeKeys.pages(), 'versions', pageId] as const,
  version: (pageId: string, versionId: string) => [...knowledgeKeys.versions(pageId), versionId] as const,
};

// =============================================================================
// Queries — Spaces
// =============================================================================

export function useKnowledgeSpaces() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: knowledgeKeys.spaces(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: KnowledgeSpace[] }>('/knowledge/spaces');
    },
  });
}

// =============================================================================
// Queries — Pages
// =============================================================================

export function useKnowledgePageTree(spaceId?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: knowledgeKeys.tree(spaceId),
    queryFn: async () => {
      const client = await getClient();
      const query = spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : '';
      return client.get<{ data: KnowledgePageTreeNode[] }>(`/knowledge/pages/tree${query}`);
    },
  });
}

export function useKnowledgePage(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: knowledgeKeys.pageDetail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: KnowledgePage }>(`/knowledge/pages/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export function useKnowledgeTrash() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: knowledgeKeys.trash(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: KnowledgeTrashedPage[] }>('/knowledge/trash');
    },
  });
}

// =============================================================================
// Queries — Versions
// =============================================================================

export function useKnowledgePageVersions(pageId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: knowledgeKeys.versions(pageId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: KnowledgePageVersionSummary[] }>(`/knowledge/pages/${pageId}/versions`);
    },
    enabled: !!pageId && enabled,
  });
}

function useKnowledgePageVersion(pageId: string, versionId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: knowledgeKeys.version(pageId, versionId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: KnowledgePageVersion }>(`/knowledge/pages/${pageId}/versions/${versionId}`);
    },
    enabled: !!pageId && !!versionId && enabled,
  });
}

// =============================================================================
// Queries — Favorites
// =============================================================================

export function useKnowledgeFavorites() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: knowledgeKeys.favorites(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: KnowledgeFavorite[] }>('/knowledge/favorites');
    },
  });
}

// =============================================================================
// Mutations — Spaces
// =============================================================================

export interface CreateKnowledgeSpaceInput {
  name: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  visibility?: KnowledgeSpaceVisibility;
}

export function useCreateKnowledgeSpace() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateKnowledgeSpaceInput) => {
      const client = await getClient();
      return client.post<{ data: KnowledgeSpace }>('/knowledge/spaces', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.spaces() });
    },
  });
}

export interface UpdateKnowledgeSpaceInput {
  name?: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  visibility?: KnowledgeSpaceVisibility;
}

export function useUpdateKnowledgeSpace() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateKnowledgeSpaceInput }) => {
      const client = await getClient();
      return client.patch<{ data: KnowledgeSpace }>(`/knowledge/spaces/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.spaces() });
      qc.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}

export function useDeleteKnowledgeSpace() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/knowledge/spaces/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.spaces() });
      qc.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}

// =============================================================================
// Mutations — Pages
// =============================================================================

export interface CreateKnowledgePageInput {
  spaceId: string;
  parentId?: string | null;
  title?: string;
  icon?: string | null;
}

export function useCreateKnowledgePage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateKnowledgePageInput) => {
      const client = await getClient();
      return client.post<{ data: KnowledgePage }>('/knowledge/pages', data);
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.tree() });
      qc.invalidateQueries({ queryKey: knowledgeKeys.tree(variables.spaceId) });
    },
  });
}

export interface UpdateKnowledgePageInput {
  title?: string;
  icon?: string | null;
  coverImage?: string | null;
  isLocked?: boolean;
}

export function useUpdateKnowledgePageMeta() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateKnowledgePageInput }) => {
      const client = await getClient();
      return client.patch<{ data: KnowledgePage }>(`/knowledge/pages/${id}`, data);
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.pageDetail(variables.id) });
      // Title/icon changes affect the sidebar tree.
      qc.invalidateQueries({ queryKey: knowledgeKeys.tree() });
    },
  });
}

export interface SaveKnowledgePageContentInput {
  contentJson: Record<string, unknown>[];
  contentText?: string;
}

/**
 * Debounced content autosave. Deliberately does NOT invalidate pageDetail —
 * the editor already holds the freshest content locally, and refetching
 * would tear down/rebuild the BlockNote instance mid-edit.
 */
export function useSaveKnowledgePageContent() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: SaveKnowledgePageContentInput }) => {
      const client = await getClient();
      return client.put<{ data: { id: string } }>(`/knowledge/pages/${id}/content`, data);
    },
  });
}

export interface MoveKnowledgePageInput {
  parentId: string | null;
  spaceId?: string;
  position?: number;
}

export function useMoveKnowledgePage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: MoveKnowledgePageInput }) => {
      const client = await getClient();
      return client.post<{ data: KnowledgePage }>(`/knowledge/pages/${id}/move`, data);
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.tree() });
      qc.invalidateQueries({ queryKey: knowledgeKeys.pageDetail(variables.id) });
      qc.invalidateQueries({ queryKey: knowledgeKeys.favorites() });
    },
  });
}

export function useDeleteKnowledgePage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/knowledge/pages/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.tree() });
      qc.invalidateQueries({ queryKey: knowledgeKeys.trash() });
      qc.invalidateQueries({ queryKey: knowledgeKeys.favorites() });
    },
  });
}

export function useRestoreKnowledgePage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<{ data: KnowledgePage }>(`/knowledge/pages/${id}/restore`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.tree() });
      qc.invalidateQueries({ queryKey: knowledgeKeys.trash() });
    },
  });
}

// =============================================================================
// Mutations — Versions
// =============================================================================

export function useCreateKnowledgePageVersion() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ pageId, label }: { pageId: string; label?: string }) => {
      const client = await getClient();
      return client.post<{ data: KnowledgePageVersion }>(`/knowledge/pages/${pageId}/versions`, { label });
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.versions(variables.pageId) });
    },
  });
}

export function useRestoreKnowledgePageVersion() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ pageId, versionId }: { pageId: string; versionId: string }) => {
      const client = await getClient();
      return client.post<{ data: KnowledgePage }>(`/knowledge/pages/${pageId}/versions/${versionId}/restore`, {});
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.pageDetail(variables.pageId) });
      qc.invalidateQueries({ queryKey: knowledgeKeys.versions(variables.pageId) });
    },
  });
}

// =============================================================================
// Mutations — Favorites
// =============================================================================

export function useAddKnowledgeFavorite() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pageId: string) => {
      const client = await getClient();
      return client.post<{ data: { id: string; pageId: string } }>('/knowledge/favorites', { pageId });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.favorites() });
    },
  });
}

export function useRemoveKnowledgeFavorite() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pageId: string) => {
      const client = await getClient();
      return client.delete<void>(`/knowledge/favorites/${pageId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: knowledgeKeys.favorites() });
    },
  });
}
