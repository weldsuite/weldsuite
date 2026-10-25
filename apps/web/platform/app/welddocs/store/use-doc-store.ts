import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useAppApi } from '@/lib/api/use-app-api';
import type { DocSnapshot } from '@weldsuite/docs-engine';
import { ApiDocDirectory } from './api-doc-directory';
import { LocalDocStore, type DocDirectory, type DocMeta } from './doc-store';

const localStores = new Map<string, LocalDocStore>();

/** The signed-out preview keeps its documents in the browser. */
export function useLocalDocStore(): LocalDocStore | null {
  const preview = usePreviewMode();
  return useMemo(() => {
    if (!preview) return null;
    let store = localStores.get('preview');
    if (!store) {
      store = new LocalDocStore('preview');
      localStores.set('preview', store);
    }
    return store;
  }, [preview]);
}

/** Where the document list lives: docs-api in a workspace, the browser in the preview. */
export function useDocDirectory(): DocDirectory | null {
  const local = useLocalDocStore();
  const workspaceId = useWorkspaceId();
  const appApi = useAppApi();
  return useMemo(() => local ?? (workspaceId ? new ApiDocDirectory(appApi.docs) : null), [local, workspaceId, appApi.docs]);
}

/** Query key prefix the `doc` entity event invalidates (lib/realtime/sync-map.ts). */
export const docsQueryKey = ['welddocs'] as const;

function useListKey() {
  const workspaceId = useWorkspaceId();
  const preview = usePreviewMode();
  return [...docsQueryKey, 'list', preview ? 'preview' : workspaceId] as const;
}

export function useDocList() {
  const directory = useDocDirectory();
  const preview = usePreviewMode();
  return useQuery({
    queryKey: useListKey(),
    queryFn: () => directory!.list(),
    enabled: !!directory,
    // The preview's documents are local data: no point persisting them in the query cache as well.
    meta: preview ? { persist: false } : undefined,
  });
}

export function useDocMutations() {
  const directory = useDocDirectory();
  const listKey = useListKey();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });
  const create = useMutation({
    mutationFn: ({ name, snapshot }: { name: string; snapshot?: DocSnapshot }) => directory!.create(name, snapshot),
    onSuccess: invalidate,
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => directory!.rename(id, name),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => directory!.remove(id),
    onSuccess: invalidate,
  });
  const importFile = useMutation({
    mutationFn: (file: File) => directory!.importFile(file),
    onSuccess: invalidate,
  });
  return { create, rename, remove, importFile };
}

export type { DocMeta };
