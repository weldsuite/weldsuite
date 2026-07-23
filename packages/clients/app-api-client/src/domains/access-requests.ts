/**
 * App-API access-requests domain client — `/api/access-requests/*`.
 *
 * Mirrors apps/workers/app-api/src/routes/access-requests/index.ts. Backs the
 * "Request access" flow: create + list-my-pending have no permission gate
 * (the requester by definition lacks the permission); resolve requires
 * `team:update`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  AccessRequest,
  CreateAccessRequestInput,
  ResolveAccessRequestInput,
} from '../schemas/access-requests';

export function createAccessRequestsApi(api: ClientApi) {
  return {
    create(input: CreateAccessRequestInput): Promise<DataResponse<AccessRequest>> {
      return api.post<DataResponse<AccessRequest>>('/access-requests', input);
    },

    listMyPending(): Promise<ListResponse<AccessRequest>> {
      return api.get<ListResponse<AccessRequest>>('/access-requests/me/pending');
    },

    resolve(
      id: string,
      input: ResolveAccessRequestInput,
    ): Promise<DataResponse<AccessRequest>> {
      return api.patch<DataResponse<AccessRequest>>(`/access-requests/${id}`, input);
    },
  };
}
