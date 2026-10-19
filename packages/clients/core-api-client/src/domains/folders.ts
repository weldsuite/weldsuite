/**
 * Folders API factory (app-api).
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse } from '../types';
import type {
  ListFoldersQuery,
  CreateFolderInput,
  UpdateDriveFolderInput,
  DriveFolder,
} from '../schemas/folders';
import type { DriveItemSharing, ShareDriveItemInput } from '../schemas/drive-shares';

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
    update(id: string, input: UpdateDriveFolderInput): Promise<DataResponse<DriveFolder>> {
      return api.patch<DataResponse<DriveFolder>>(`/folders/${id}`, input);
    },
    delete(id: string): Promise<DataResponse<{ deleted: boolean }>> {
      return api.delete<DataResponse<{ deleted: boolean }>>(`/folders/${id}`);
    },
    /** Who the folder (and what is in it) is open to. */
    sharing(id: string): Promise<DataResponse<DriveItemSharing>> {
      return api.get<DataResponse<DriveItemSharing>>(`/folders/${id}/shares`);
    },
    /** Share the folder with a teammate, or change the role they have. */
    share(id: string, userId: string, input: ShareDriveItemInput): Promise<DataResponse<DriveItemSharing>> {
      return api.put<DataResponse<DriveItemSharing>>(`/folders/${id}/shares/${encodeURIComponent(userId)}`, input);
    },
    /** Stop sharing the folder with a teammate (or, for yourself, leave it). */
    unshare(id: string, userId: string): Promise<DataResponse<DriveItemSharing | null>> {
      return api.delete<DataResponse<DriveItemSharing | null>>(`/folders/${id}/shares/${encodeURIComponent(userId)}`);
    },
  };
}
