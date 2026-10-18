/**
 * Files API factory (app-api).
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse } from '../types';
import type {
  ListFilesQuery,
  CreateFileInput,
  UpdateDriveFileInput,
  MoveFileInput,
  DriveFile,
  FilesListResponse,
} from '../schemas/files';
import type { DriveItemSharing, ShareDriveItemInput } from '../schemas/drive-shares';

export function createFilesApi(api: ClientApi) {
  return {
    list(params: ListFilesQuery = {}): Promise<FilesListResponse> {
      const qs = buildQueryString(params as Record<string, unknown>);
      return api.get<FilesListResponse>(`/files${qs}`);
    },
    get(id: string): Promise<DataResponse<DriveFile>> {
      return api.get<DataResponse<DriveFile>>(`/files/${id}`);
    },
    create(input: CreateFileInput): Promise<DataResponse<DriveFile>> {
      return api.post<DataResponse<DriveFile>>('/files', input);
    },
    update(id: string, input: UpdateDriveFileInput): Promise<DataResponse<DriveFile>> {
      return api.patch<DataResponse<DriveFile>>(`/files/${id}`, input);
    },
    delete(id: string): Promise<DataResponse<{ deleted: boolean }>> {
      return api.delete<DataResponse<{ deleted: boolean }>>(`/files/${id}`);
    },
    star(id: string): Promise<DataResponse<{ isStarred: boolean }>> {
      return api.post<DataResponse<{ isStarred: boolean }>>(`/files/${id}/star`);
    },
    move(id: string, input: MoveFileInput): Promise<DataResponse<{ moved: boolean; folderId: string | null }>> {
      return api.post<DataResponse<{ moved: boolean; folderId: string | null }>>(
        `/files/${id}/move`,
        input,
      );
    },
    /** Who the file is open to: its owner, general access and the people it is shared with. */
    sharing(id: string): Promise<DataResponse<DriveItemSharing>> {
      return api.get<DataResponse<DriveItemSharing>>(`/files/${id}/shares`);
    },
    /** Share the file with a teammate, or change the role they have. */
    share(id: string, userId: string, input: ShareDriveItemInput): Promise<DataResponse<DriveItemSharing>> {
      return api.put<DataResponse<DriveItemSharing>>(`/files/${id}/shares/${encodeURIComponent(userId)}`, input);
    },
    /** Stop sharing the file with a teammate (or, for yourself, leave it). */
    unshare(id: string, userId: string): Promise<DataResponse<DriveItemSharing | null>> {
      return api.delete<DataResponse<DriveItemSharing | null>>(`/files/${id}/shares/${encodeURIComponent(userId)}`);
    },
  };
}
