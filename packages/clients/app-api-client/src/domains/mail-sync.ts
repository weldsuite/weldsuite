/**
 * App-API mail-sync domain client — flat `/api/mail-sync/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  SyncMessagesQuery,
  ForceResyncInput,
  UpdateMailSyncStatusInput,
} from '../schemas/mail-sync';

export interface SyncStatusResult {
  status: string;
  lastSyncAt: string | null;
}

export interface SyncTriggerResult {
  accountId: string;
  status: 'syncing';
  syncedMessages: number;
  label?: string;
}

export function createMailSyncApi(api: ClientApi) {
  return {
    syncMessages(
      accountId: string,
      params: Partial<SyncMessagesQuery> = {},
    ): Promise<DataResponse<SyncTriggerResult>> {
      return api.post<DataResponse<SyncTriggerResult>>(
        `/mail-sync/accounts/${accountId}/sync-messages${buildQueryString(params as Record<string, unknown>)}`,
        {},
      );
    },

    fullSync(accountId: string): Promise<DataResponse<SyncTriggerResult>> {
      return api.post<DataResponse<SyncTriggerResult>>(
        `/mail-sync/accounts/${accountId}/full-sync`,
        {},
      );
    },

    forceResync(
      accountId: string,
      data: ForceResyncInput,
    ): Promise<DataResponse<SyncTriggerResult>> {
      return api.post<DataResponse<SyncTriggerResult>>(
        `/mail-sync/accounts/${accountId}/force-resync`,
        data,
      );
    },

    getSyncStatus(accountId: string): Promise<DataResponse<SyncStatusResult>> {
      return api.get<DataResponse<SyncStatusResult>>(
        `/mail-sync/accounts/${accountId}/sync-status`,
      );
    },

    setSyncStatus(
      accountId: string,
      data: UpdateMailSyncStatusInput,
    ): Promise<DataResponse<{ id: string; status: string }>> {
      return api.patch<DataResponse<{ id: string; status: string }>>(
        `/mail-sync/accounts/${accountId}/sync-status`,
        data,
      );
    },
  };
}
