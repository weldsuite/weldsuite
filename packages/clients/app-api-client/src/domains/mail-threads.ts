/**
 * App-API mail-threads domain client — flat `/api/mail-threads/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type { MarkThreadReadInput } from '../schemas/mail-threads';

export function createMailThreadsApi(api: ClientApi) {
  return {
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
