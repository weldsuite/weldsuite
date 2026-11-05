import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardSnapshot } from '@weldsuite/board-engine';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useAppApi } from '@/lib/api/use-app-api';
import { ApiBoardDirectory } from './api-board-directory';
import { LocalBoardStore, type BoardDirectory, type BoardMeta } from './board-store';

const localStores = new Map<string, LocalBoardStore>();

/** The signed-out preview keeps its boards in the browser. */
export function useLocalBoardStore(): LocalBoardStore | null {
  const preview = usePreviewMode();
  return useMemo(() => {
    if (!preview) return null;
    let store = localStores.get('preview');
    if (!store) {
      store = new LocalBoardStore('preview');
      localStores.set('preview', store);
    }
    return store;
  }, [preview]);
}

export function useBoardDirectory(): BoardDirectory | null {
  const local = useLocalBoardStore();
  const workspaceId = useWorkspaceId();
  const appApi = useAppApi();
  return useMemo(() => local ?? (workspaceId ? new ApiBoardDirectory(appApi.boards) : null), [local, workspaceId, appApi.boards]);
}

/** Query key prefix the `board` entity event invalidates (lib/realtime/sync-map.ts). */
export const boardsQueryKey = ['weldboard'] as const;

export interface BoardListOptions {
  projectId?: string;
  templates?: boolean;
  projects?: boolean;
}

function useListKey(options: BoardListOptions) {
  const workspaceId = useWorkspaceId();
  const preview = usePreviewMode();
  return [...boardsQueryKey, 'list', preview ? 'preview' : workspaceId, options.projectId ?? null, !!options.templates, !!options.projects] as const;
}

export function useBoardList(options: BoardListOptions = {}, enabled = true) {
  const directory = useBoardDirectory();
  const preview = usePreviewMode();
  const local = preview && (options.projectId || options.templates || options.projects);
  return useQuery({
    queryKey: useListKey(options),
    queryFn: () => (local ? Promise.resolve([] as BoardMeta[]) : directory!.list(options)),
    enabled: !!directory && enabled,
    meta: preview ? { persist: false } : undefined,
  });
}

export function useBoardMutations() {
  const directory = useBoardDirectory();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: boardsQueryKey });
  const create = useMutation({
    mutationFn: ({ name, snapshot, projectId, fromBoardId }: { name: string; snapshot?: BoardSnapshot; projectId?: string; fromBoardId?: string }) =>
      directory!.create(name, { snapshot, projectId, fromBoardId }),
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
  return { create, rename, remove };
}

export type { BoardMeta };
