import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  UnifiedFile,
  DriveFolder,
  DriveFile,
  DriveFilesParams,
  DriveFilesResponse,
  DriveStatsResponse,
  CreateFolderInput,
  CreateFileInput,
  PaginationMeta,
} from '@/lib/api/domains/welddrive';
import type {
  DriveGeneralAccess,
  DriveItemSharing,
  DriveShareRole,
  SharedWithMe,
} from '@weldsuite/core-api-client/schemas/drive-shares';

// ── Query Key Factories ─────────────────────────────────────────────────

const driveKeys = {
  all: ['drive'] as const,
  files: (params?: DriveFilesParams) => [...driveKeys.all, 'files', params] as const,
  file: (id: string) => [...driveKeys.all, 'file', id] as const,
  folders: (parentId?: string | null) => [...driveKeys.all, 'folders', parentId] as const,
  aggregated: (params?: DriveFilesParams) => [...driveKeys.all, 'aggregated', params] as const,
  stats: () => [...driveKeys.all, 'stats'] as const,
  trash: () => [...driveKeys.all, 'trash'] as const,
  shared: () => [...driveKeys.all, 'shared'] as const,
  sharing: (item: DriveItemRef) => [...driveKeys.all, 'sharing', item.kind, item.id] as const,
};

/** A Drive file or folder, for the sharing hooks. */
export interface DriveItemRef {
  kind: 'file' | 'folder';
  id: string;
}

// ── File Queries (Generic Store) ────────────────────────────────────────

export function useDriveFiles(params?: DriveFilesParams) {
  const { files } = useAppApi();
  return useQuery({
    queryKey: driveKeys.files(params),
    queryFn: () => files.list((params ?? {}) as DriveFilesParams) as Promise<{
      success: boolean;
      data: UnifiedFile[];
      pagination: PaginationMeta;
    }>,
  });
}

/** One drive file row by id (a shared `/welddrive?file=` link). */
export function useDriveFile(id: string | null | undefined) {
  const { files } = useAppApi();
  return useQuery({
    queryKey: driveKeys.file(id ?? ''),
    queryFn: () => files.get(id!) as unknown as Promise<{ success: boolean; data: DriveFile }>,
    enabled: !!id,
    retry: false,
  });
}
// ── Folder Queries ──────────────────────────────────────────────────────

export function useDriveFolders(parentId?: string | null) {
  const { folders } = useAppApi();
  return useQuery({
    queryKey: driveKeys.folders(parentId),
    queryFn: () =>
      folders.list(parentId ? { parentId } : {}) as unknown as Promise<{
        success: boolean;
        data: DriveFolder[];
      }>,
  });
}

/** Every folder the caller can see. `enabled` keeps it quiet for a caller who may not read folders. */
export function useAllDriveFolders(enabled = true) {
  const { folders } = useAppApi();
  return useQuery({
    queryKey: [...driveKeys.all, 'all-folders'] as const,
    queryFn: () =>
      folders.listAll() as unknown as Promise<{ success: boolean; data: DriveFolder[] }>,
    enabled,
  });
}

// ── Aggregation Queries ─────────────────────────────────────────────────

export function useAllFiles(params?: DriveFilesParams) {
  const { drive } = useAppApi();
  return useQuery({
    queryKey: driveKeys.aggregated(params),
    queryFn: () => drive.all((params ?? {}) as DriveFilesParams) as Promise<DriveFilesResponse>,
  });
}

export function useDriveStats() {
  const { drive } = useAppApi();
  return useQuery({
    queryKey: driveKeys.stats(),
    queryFn: () => drive.stats() as Promise<DriveStatsResponse>,
  });
}

// ── File Mutations ──────────────────────────────────────────────────────

export function useCreateDriveFile() {
  const queryClient = useQueryClient();
  const { files } = useAppApi();
  return useMutation({
    mutationFn: (data: CreateFileInput) =>
      files.create(data) as unknown as Promise<{ success: boolean; data: DriveFile }>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

export function useUpdateDriveFile() {
  const queryClient = useQueryClient();
  const { files } = useAppApi();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string;
      fileName?: string;
      folderId?: string | null;
      isStarred?: boolean;
      isPublic?: boolean;
      description?: string | null;
    }) => files.update(id, data) as unknown as Promise<{ success: boolean; data: DriveFile }>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

export function useDeleteDriveFile() {
  const queryClient = useQueryClient();
  const { files } = useAppApi();
  return useMutation({
    mutationFn: (id: string) => files.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

/** `old` with the file `id` starred or unstarred, for any cached `{ data: [...] }` drive list. */
function withStarToggled(old: unknown, id: string): unknown {
  if (!old || typeof old !== 'object' || !('data' in old) || !Array.isArray(old.data)) return old;
  const rows = old.data as Array<{ id?: string; isStarred?: unknown }>;
  if (!rows.some((row) => row?.id === id && typeof row.isStarred === 'boolean')) return old;
  return {
    ...old,
    data: rows.map((row) => (row?.id === id ? { ...row, isStarred: !row.isStarred } : row)),
  };
}

export function useStarDriveFile() {
  const queryClient = useQueryClient();
  const { files } = useAppApi();
  return useMutation({
    mutationFn: (id: string) =>
      files.star(id) as unknown as Promise<{ success: boolean; data: { isStarred: boolean } }>,
    // Flip the star in every cached list right away, so the row shows it
    // without waiting for the refetch.
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: driveKeys.all });
      const snapshots = queryClient.getQueriesData({ queryKey: driveKeys.all });
      queryClient.setQueriesData({ queryKey: driveKeys.all }, (old: unknown) => withStarToggled(old, id));
      return { snapshots };
    },
    onError: (_err, _id, context) => {
      context?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

export function useMoveDriveFile() {
  const queryClient = useQueryClient();
  const { files } = useAppApi();
  return useMutation({
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) =>
      files.move(id, { folderId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

// ── Folder Mutations ────────────────────────────────────────────────────

export function useCreateDriveFolder() {
  const queryClient = useQueryClient();
  const { folders } = useAppApi();
  return useMutation({
    mutationFn: (data: CreateFolderInput) =>
      folders.create(data) as unknown as Promise<{ success: boolean; data: DriveFolder }>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

export function useUpdateDriveFolder() {
  const queryClient = useQueryClient();
  const { folders } = useAppApi();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string;
      name?: string;
      parentId?: string | null;
      color?: string | null;
      icon?: string | null;
    }) => folders.update(id, data) as unknown as Promise<{ success: boolean; data: DriveFolder }>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

export function useDeleteDriveFolder() {
  const queryClient = useQueryClient();
  const { folders } = useAppApi();
  return useMutation({
    mutationFn: (id: string) => folders.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

// ── Sharing ────────────────────────────────────────────────────────────

/** Files and folders teammates shared with the current user (Shared with me). */
export function useSharedWithMe(enabled = true) {
  const { drive } = useAppApi();
  return useQuery({
    queryKey: driveKeys.shared(),
    queryFn: async (): Promise<SharedWithMe> => (await drive.shared()).data,
    enabled,
  });
}

/** Who a file or folder is open to: owner, general access, the people it is shared with. */
export function useDriveItemSharing(item: DriveItemRef | null) {
  const { files, folders } = useAppApi();
  return useQuery({
    queryKey: driveKeys.sharing(item ?? { kind: 'file', id: '' }),
    queryFn: async (): Promise<DriveItemSharing> => {
      const api = item!.kind === 'file' ? files : folders;
      return (await api.sharing(item!.id)).data;
    },
    enabled: !!item,
    retry: false,
  });
}

/** Share an item with a teammate, or change their role. */
export function useShareDriveItem() {
  const queryClient = useQueryClient();
  const { files, folders } = useAppApi();
  return useMutation({
    mutationFn: ({ item, userId, role }: { item: DriveItemRef; userId: string; role: DriveShareRole }) =>
      (item.kind === 'file' ? files : folders).share(item.id, userId, { role }),
    onSuccess: (res, { item }) => {
      queryClient.setQueryData(driveKeys.sharing(item), res.data);
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

/** Stop sharing an item with a teammate (yourself: leave it). */
export function useUnshareDriveItem() {
  const queryClient = useQueryClient();
  const { files, folders } = useAppApi();
  return useMutation({
    mutationFn: ({ item, userId }: { item: DriveItemRef; userId: string }) =>
      (item.kind === 'file' ? files : folders).unshare(item.id, userId),
    onSuccess: (res, { item }) => {
      if (res.data) queryClient.setQueryData(driveKeys.sharing(item), res.data);
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

/** Change who besides the people it is shared with may open an item. */
export function useSetDriveGeneralAccess() {
  const queryClient = useQueryClient();
  const { files, folders } = useAppApi();
  return useMutation({
    mutationFn: async ({ item, generalAccess }: { item: DriveItemRef; generalAccess: DriveGeneralAccess }): Promise<void> => {
      if (item.kind === 'file') await files.update(item.id, { generalAccess });
      else await folders.update(item.id, { generalAccess });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

// ── Trash ──────────────────────────────────────────────────────────────

export function useDriveTrash() {
  const { drive } = useAppApi();
  return useQuery({
    queryKey: driveKeys.trash(),
    queryFn: async () => {
      const res = await drive.trash();
      return res.data;
    },
  });
}

export function useRestoreDriveFile() {
  const queryClient = useQueryClient();
  const { drive } = useAppApi();
  return useMutation({
    mutationFn: (id: string) => drive.restoreFile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

export function useRestoreDriveFolder() {
  const queryClient = useQueryClient();
  const { drive } = useAppApi();
  return useMutation({
    mutationFn: (id: string) => drive.restoreFolder(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

export function usePermanentDeleteDriveFile() {
  const queryClient = useQueryClient();
  const { drive } = useAppApi();
  return useMutation({
    mutationFn: (id: string) => drive.permanentDeleteFile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

export function usePermanentDeleteDriveFolder() {
  const queryClient = useQueryClient();
  const { drive } = useAppApi();
  return useMutation({
    mutationFn: (id: string) => drive.permanentDeleteFolder(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}

export function useEmptyDriveTrash() {
  const queryClient = useQueryClient();
  const { drive } = useAppApi();
  return useMutation({
    mutationFn: () => drive.emptyTrash(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: driveKeys.all });
    },
  });
}
