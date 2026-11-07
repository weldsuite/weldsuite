/**
 * SLA policies domain client — flat /api/slas/* surface (desk-api).
 *
 * The engine that reads these rows is `@weldsuite/db/lib/desk-sla` (ADR DESK-009).
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type { CreateSlaInput, Sla, UpdateSlaInput } from '../schemas/slas';

export interface ListSlasQuery {
  search?: string;
  limit?: number;
  cursor?: string;
}

export function createSlasApi(api: ClientApi) {
  return {
    list(params: ListSlasQuery = {}): Promise<ListResponse<Sla>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<Sla>>(`/slas${query}`);
    },

    get(id: string): Promise<DataResponse<Sla>> {
      return api.get<DataResponse<Sla>>(`/slas/${id}`);
    },

    create(data: CreateSlaInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/slas', data);
    },

    update(id: string, data: UpdateSlaInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/slas/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/slas/${id}`);
    },
  };
}
