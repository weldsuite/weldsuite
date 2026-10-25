/**
 * App-API mail-threads domain client — flat `/api/mail-threads/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type { MarkFolderReadInput, MarkThreadReadInput } from '../schemas/mail-threads';

export function createMailThreadsApi(api: ClientApi) {
  return {
    /** Mark every thread in a folder read. */
    markAllRead(data: MarkFolderReadInput): Promise<DataResponse<{ updatedCount: number }>> {
      return api.post<DataResponse<{ updatedCount: number }>>('/mail-threads/read-all', data);
    },

    markRead(
      threadId: string,
      accountId: string,
      data: MarkThreadReadInput,
    ): Promise<DataResponse<{ updatedCount: number }>> {
      return api.post<DataResponse<{ updatedCount: number }>>(
        `/mail-threads/${threadId}/read${buildQueryString({ accountId })}`,
        data,
      );
    },
  };
}
