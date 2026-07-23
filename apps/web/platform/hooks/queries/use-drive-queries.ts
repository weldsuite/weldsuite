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

// ── Query Key Factories ─────────────────────────────────────────────────

const driveKeys = {
  all: ['drive'] as const,
  files: (params?: DriveFilesParams) => [...driveKeys.all, 'files', params] as const,
  file: (id: string) => [...driveKeys.all, 'file', id] as const,
  folders: (parentId?: string | null) => [...driveKeys.all, 'folders', parentId] as const,
  aggregated: (params?: DriveFilesParams) => [...driveKeys.all, 'aggregated', params] as const,
  stats: () => [...driveKeys.all, 'stats'] as const,
  trash: () => [...driveKeys.all, 'trash'] as const,
};

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

function useDriveFile(id: string) {
  const { files } = useAppApi();
  return useQuery({
    queryKey: driveKeys.file(id),
    queryFn: () => files.get(id) as unknown as Promise<{ success: boolean; data: DriveFile }>,
    enabled: !!id,
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

export function useAllDriveFolders() {
  const { folders } = useAppApi();
  return useQuery({
    queryKey: [...driveKeys.all, 'all-folders'] as const,
    queryFn: () =>
      folders.listAll() as unknown as Promise<{ success: boolean; data: DriveFolder[] }>,
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

export function useStarDriveFile() {
  const queryClient = useQueryClient();
  const { files } = useAppApi();
  return useMutation({
    mutationFn: (id: string) =>
      files.star(id) as unknown as Promise<{ success: boolean; data: { isStarred: boolean } }>,
    onSuccess: () => {
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
