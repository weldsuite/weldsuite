import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  AccessRequest,
  CreateAccessRequestInput,
  ResolveAccessRequestInput,
} from '../schemas/access-requests';

export function createAccessRequestsApi(api: ClientApi) {
  return {
    create(input: CreateAccessRequestInput): Promise<DataResponse<AccessRequest>> {
      return api.post<DataResponse<AccessRequest>>('/team/access-requests', input);
    },

    listMyPending(): Promise<ListResponse<AccessRequest>> {
      return api.get<ListResponse<AccessRequest>>('/team/access-requests/me/pending');
    },

    resolve(
      id: string,
      input: ResolveAccessRequestInput,
    ): Promise<DataResponse<AccessRequest>> {
      return api.patch<DataResponse<AccessRequest>>(
        `/team/access-requests/${id}`,
        input,
      );
    },
  };
}
