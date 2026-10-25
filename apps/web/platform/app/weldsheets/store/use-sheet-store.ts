import { useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useAppApi } from '@/lib/api/use-app-api';
import type { SheetFileLocale } from '@weldsuite/app-api-client/schemas/sheets';
import { LocalSheetStore, type SheetDirectory, type SheetMeta } from './sheet-store';
import { ApiSheetDirectory } from './api-sheet-directory';

const localStores = new Map<string, LocalSheetStore>();

/** The signed-out preview keeps its sheets in the browser. */
export function useLocalSheetStore(): LocalSheetStore | null {
  const preview = usePreviewMode();
  return useMemo(() => {
    if (!preview) return null;
    let store = localStores.get('preview');
    if (!store) {
      store = new LocalSheetStore('preview');
      localStores.set('preview', store);
    }
    return store;
  }, [preview]);
}

/** Where the sheet list lives: sheets-api in a workspace, the browser in the preview. */
export function useSheetDirectory(): SheetDirectory | null {
  const local = useLocalSheetStore();
  const workspaceId = useWorkspaceId();
  const appApi = useAppApi();
  return useMemo(() => local ?? (workspaceId ? new ApiSheetDirectory(appApi.sheets) : null), [local, workspaceId, appApi.sheets]);
}

/** Query key prefix the `sheet` entity event invalidates (lib/realtime/sync-map.ts). */
export const sheetsQueryKey = ['weldsheets'] as const;

function useListKey() {
  const workspaceId = useWorkspaceId();
  const preview = usePreviewMode();
  return [...sheetsQueryKey, 'list', preview ? 'preview' : workspaceId] as const;
}

export function useSheetList() {
  const directory = useSheetDirectory();
  const preview = usePreviewMode();
  return useQuery({
    queryKey: useListKey(),
    queryFn: () => directory!.list(),
    enabled: !!directory,
    // The preview's sheets are local data: no point persisting them in the query cache as well.
    meta: preview ? { persist: false } : undefined,
  });
}

export function useSheetMutations() {
  const directory = useSheetDirectory();
  const listKey = useListKey();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });
  const create = useMutation({
    mutationFn: ({ name, firstTabName }: { name: string; firstTabName: string }) => directory!.create(name, firstTabName),
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
    mutationFn: ({ file, locale }: { file: File; locale: SheetFileLocale }) => directory!.importFile(file, locale),
    onSuccess: invalidate,
  });
  return { create, rename, remove, importFile };
}

export type { SheetMeta };
