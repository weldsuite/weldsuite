/**
 * App-API companies domain client — flat /api/companies/* surface.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  Company,
  CreateCompanyInput,
  UpdateCompanyInput,
  ListCompaniesQuery,
  CompanyDetailQuery,
  BulkUpdateCompaniesInput,
} from '../schemas/companies';

export function createCompaniesApi(api: ClientApi) {
  return {
    list(params: Partial<ListCompaniesQuery> = {}): Promise<ListResponse<Company>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<Company>>(`/companies${query}`);
    },

    get(
      id: string,
      params: Partial<CompanyDetailQuery> = {},
    ): Promise<DataResponse<Company>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<DataResponse<Company>>(`/companies/${id}${query}`);
    },

    create(data: CreateCompanyInput): Promise<DataResponse<Company>> {
      return api.post<DataResponse<Company>>('/companies', data);
    },

    update(id: string, data: UpdateCompanyInput): Promise<DataResponse<Company>> {
      return api.patch<DataResponse<Company>>(`/companies/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/companies/${id}`);
    },

    bulkUpdate(data: BulkUpdateCompaniesInput): Promise<DataResponse<{ updated: number }>> {
      return api.post<DataResponse<{ updated: number }>>('/companies/bulk-update', data);
    },
  };
}
