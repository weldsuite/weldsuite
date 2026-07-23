/**
 * Files API factory (app-api).
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse } from '../types';
import type {
  ListFilesQuery,
  CreateFileInput,
  UpdateFileInput,
  MoveFileInput,
  DriveFile,
  FilesListResponse,
} from '../schemas/files';

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
    update(id: string, input: UpdateFileInput): Promise<DataResponse<DriveFile>> {
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
  };
}
