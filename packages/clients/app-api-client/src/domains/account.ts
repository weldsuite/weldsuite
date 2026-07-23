/**
 * App-API account domain client — `/api/account`.
 *
 * Self-service account deletion (Google Play / GDPR). Org-less: works for
 * users that have no active workspace selected.
 */

import type { ClientApi, DataResponse } from '../types';
import type {
  AccountDeletionStatus,
  DeleteAccountInput,
  DeleteAccountResult,
} from '../schemas/account';

export function createAccountApi(api: ClientApi) {
  return {
    getDeletionStatus(): Promise<DataResponse<AccountDeletionStatus>> {
      return api.get<DataResponse<AccountDeletionStatus>>('/account/deletion-status');
    },

    deleteAccount(data: DeleteAccountInput): Promise<DataResponse<DeleteAccountResult>> {
      return api.post<DataResponse<DeleteAccountResult>>('/account/delete', data);
    },
  };
}
