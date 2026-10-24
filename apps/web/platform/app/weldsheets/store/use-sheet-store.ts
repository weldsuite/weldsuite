import { useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { LocalSheetStore, type SheetMeta, type SheetStore } from './sheet-store';

const stores = new Map<string, SheetStore>();

/** The workspace the store is keyed by; the unauthenticated preview gets its own. */
function useStoreWorkspaceId(): string | null {
  const workspaceId = useWorkspaceId();
  const preview = usePreviewMode();
  return workspaceId ?? (preview ? 'preview' : null);
}

/** The store for the current workspace (one per workspace for the session). */
export function useSheetStore(): SheetStore | null {
  const workspaceId = useStoreWorkspaceId();
  return useMemo(() => {
    if (!workspaceId) return null;
    let store = stores.get(workspaceId);
    if (!store) {
      store = new LocalSheetStore(workspaceId);
      stores.set(workspaceId, store);
    }
    return store;
  }, [workspaceId]);
}

const listKey = (workspaceId: string | null) => ['weldsheets', 'list', workspaceId] as const;

export function useSheetList() {
  const store = useSheetStore();
  const workspaceId = useStoreWorkspaceId();
  return useQuery({
    queryKey: listKey(workspaceId),
    queryFn: () => store!.list(),
    enabled: !!store,
    // Local data: no point persisting it in the query cache as well.
    meta: { persist: false },
  });
}

export function useSheetMutations() {
  const store = useSheetStore();
  const workspaceId = useStoreWorkspaceId();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey(workspaceId) });
  const create = useMutation({
    mutationFn: (name: string) => store!.create(name),
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
  return { create, rename, remove };
}

export type { SheetMeta };
