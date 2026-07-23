/**
 * Folders API factory (app-api).
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse } from '../types';
import type {
  ListFoldersQuery,
  CreateFolderInput,
  UpdateFolderInput,
  DriveFolder,
} from '../schemas/folders';

export function createFoldersApi(api: ClientApi) {
  return {
    list(params: ListFoldersQuery = {}): Promise<DataResponse<DriveFolder[]>> {
      const qs = buildQueryString(params as Record<string, unknown>);
      return api.get<DataResponse<DriveFolder[]>>(`/folders${qs}`);
    },
    listAll(): Promise<DataResponse<DriveFolder[]>> {
      return api.get<DataResponse<DriveFolder[]>>('/folders?all=true');
    },
    get(id: string): Promise<DataResponse<DriveFolder>> {
      return api.get<DataResponse<DriveFolder>>(`/folders/${id}`);
    },
    create(input: CreateFolderInput): Promise<DataResponse<DriveFolder>> {
      return api.post<DataResponse<DriveFolder>>('/folders', input);
    },
    update(id: string, input: UpdateFolderInput): Promise<DataResponse<DriveFolder>> {
      return api.patch<DataResponse<DriveFolder>>(`/folders/${id}`, input);
    },
    delete(id: string): Promise<DataResponse<{ deleted: boolean }>> {
      return api.delete<DataResponse<{ deleted: boolean }>>(`/folders/${id}`);
    },
  };
}
