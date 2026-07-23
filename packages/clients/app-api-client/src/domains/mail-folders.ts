/**
 * App-API mail-folders domain client — flat `/api/mail-folders/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateMailFolderInput,
  UpdateMailFolderInput,
  ListMailFoldersQuery,
} from '../schemas/mail-folders';

export interface MailFolderRow {
  id: string;
  accountId: string;
  name: string;
  type: string;
  parentId: string | null;
  path: string | null;
  totalCount: number;
  unreadCount: number;
  unseenCount: number | null;
  lastSyncAt: string | null;
  syncStatus: string | null;
  uidValidity: number | null;
  uidNext: number | null;
  isSelectable: boolean;
  isSubscribed: boolean | null;
  color: string | null;
  icon: string | null;
  position: number;
  isSystem: boolean | null;
  specialUse: string[] | null;
  externalFolderId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function createMailFoldersApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailFoldersQuery> = {}): Promise<DataResponse<MailFolderRow[]>> {
      return api.get<DataResponse<MailFolderRow[]>>(
        `/mail-folders${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<MailFolderRow>> {
      return api.get<DataResponse<MailFolderRow>>(`/mail-folders/${id}`);
    },

    create(data: CreateMailFolderInput): Promise<DataResponse<MailFolderRow>> {
      return api.post<DataResponse<MailFolderRow>>('/mail-folders', data);
    },

    update(id: string, data: UpdateMailFolderInput): Promise<DataResponse<MailFolderRow>> {
      return api.patch<DataResponse<MailFolderRow>>(`/mail-folders/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-folders/${id}`);
    },
  };
}
