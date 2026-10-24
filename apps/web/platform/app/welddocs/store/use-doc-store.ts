import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useWorkspaceId } from '@/contexts/workspace-context';
import type { DocSnapshot } from '@weldsuite/docs-engine';
import { LocalDocStore, type DocMeta } from './doc-store';

const stores = new Map<string, LocalDocStore>();

/** The workspace the store is keyed by; the unauthenticated preview gets its own. */
function useStoreWorkspaceId(): string | null {
  const workspaceId = useWorkspaceId();
  const preview = usePreviewMode();
  return preview ? 'preview' : (workspaceId ?? null);
}

/** The browser store for the current workspace (one per workspace for the session). */
export function useLocalDocStore(): LocalDocStore | null {
  const workspaceId = useStoreWorkspaceId();
  return useMemo(() => {
    if (!workspaceId) return null;
    let store = stores.get(workspaceId);
    if (!store) {
      store = new LocalDocStore(workspaceId);
      stores.set(workspaceId, store);
    }
    return store;
  }, [workspaceId]);
}

/** Query key prefix for document lists. */
export const docsQueryKey = ['welddocs'] as const;

function useListKey() {
  const workspaceId = useStoreWorkspaceId();
  return [...docsQueryKey, 'list', workspaceId] as const;
}

export function useDocList() {
  const store = useLocalDocStore();
  return useQuery({
    queryKey: useListKey(),
    queryFn: () => store!.list(),
    enabled: !!store,
    // Local data: no point persisting it in the query cache as well.
    meta: { persist: false },
  });
}

export function useDocMutations() {
  const store = useLocalDocStore();
  const listKey = useListKey();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });
  const create = useMutation({
    mutationFn: ({ name, snapshot }: { name: string; snapshot?: DocSnapshot }) => store!.create(name, snapshot),
    onSuccess: invalidate,
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => store!.rename(id, name),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => store!.remove(id),
    onSuccess: invalidate,
  });
  const importFile = useMutation({
    mutationFn: (file: File) => store!.importFile(file),
    onSuccess: invalidate,
  });
  return { create, rename, remove, importFile };
}

export type { DocMeta };
