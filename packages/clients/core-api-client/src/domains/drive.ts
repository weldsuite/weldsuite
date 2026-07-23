/**
 * Drive cross-cutting API factory (app-api).
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse } from '../types';
import type {
  ListAllFilesQuery,
  DriveFilesResponse,
  DriveStatsResponse,
  DriveTrash,
} from '../schemas/drive';

export function createDriveApi(api: ClientApi) {
  return {
    all(params: ListAllFilesQuery = {}): Promise<DriveFilesResponse> {
      const qs = buildQueryString(params as Record<string, unknown>);
      return api.get<DriveFilesResponse>(`/drive/all${qs}`);
    },
    stats(): Promise<DriveStatsResponse> {
      return api.get<DriveStatsResponse>('/drive/stats');
    },
    trash(): Promise<DataResponse<DriveTrash>> {
      return api.get<DataResponse<DriveTrash>>('/drive/trash');
    },
    restoreFile(id: string): Promise<DataResponse<{ restored: boolean }>> {
      return api.post<DataResponse<{ restored: boolean }>>(`/drive/trash/restore/file/${id}`);
    },
    restoreFolder(id: string): Promise<DataResponse<{ restored: boolean }>> {
      return api.post<DataResponse<{ restored: boolean }>>(`/drive/trash/restore/folder/${id}`);
    },
    permanentDeleteFile(id: string): Promise<DataResponse<{ deleted: boolean }>> {
      return api.delete<DataResponse<{ deleted: boolean }>>(`/drive/trash/file/${id}`);
    },
    permanentDeleteFolder(id: string): Promise<DataResponse<{ deleted: boolean }>> {
      return api.delete<DataResponse<{ deleted: boolean }>>(`/drive/trash/folder/${id}`);
    },
    emptyTrash(): Promise<DataResponse<{ emptied: boolean }>> {
      return api.delete<DataResponse<{ emptied: boolean }>>('/drive/trash/empty');
    },
  };
}
