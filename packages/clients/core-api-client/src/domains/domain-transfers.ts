/**
 * Domain transfers API factory (app-api).
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  ListDomainTransfersQuery,
  CreateDomainTransferInput,
  FailDomainTransferInput,
  DomainTransfer,
} from '../schemas/domain-transfers';

export function createDomainTransfersApi(api: ClientApi) {
  return {
    list(params: ListDomainTransfersQuery = {}): Promise<ListResponse<DomainTransfer>> {
      const qs = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<DomainTransfer>>(`/domain-transfers${qs}`);
    },
    get(id: string): Promise<DataResponse<DomainTransfer>> {
      return api.get<DataResponse<DomainTransfer>>(`/domain-transfers/${id}`);
    },
    create(input: CreateDomainTransferInput): Promise<DataResponse<DomainTransfer>> {
      return api.post<DataResponse<DomainTransfer>>('/domain-transfers', input);
    },
    complete(id: string): Promise<DataResponse<DomainTransfer>> {
      return api.patch<DataResponse<DomainTransfer>>(`/domain-transfers/${id}/complete`);
    },
    fail(id: string, input: FailDomainTransferInput = {}): Promise<DataResponse<DomainTransfer>> {
      return api.patch<DataResponse<DomainTransfer>>(`/domain-transfers/${id}/fail`, input);
    },
  };
}
