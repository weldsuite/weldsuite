/**
 * App-API tickets domain client — flat /api/tickets/* surface.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateTicketInput,
  UpdateTicketInput,
  ListTicketsQuery,
} from '../schemas/tickets';

export interface TicketRow {
  id: string;
  ticketNumber?: string | null;
  reference?: string | null;

  contactId?: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  customerCompany?: string | null;

  subject: string;
  description?: string | null;
  category?: string | null;
  subcategory?: string | null;

  status: string;
  priority: string;
  severity?: string | null;

  assigneeId?: string | null;
  assigneeName?: string | null;
  departmentId?: string | null;
  teamId?: string | null;

  channel?: string | null;
  sourceEmail?: string | null;
  sourceUrl?: string | null;

  type?: string | null;
  ticketTypeId?: string | null;
  issueType?: string | null;

  slaId?: string | null;

  productId?: string | null;
  productName?: string | null;

  tags?: string[] | null;
  customFields?: Record<string, unknown> | null;

  parentTicketId?: string | null;
  isPublic?: boolean | null;
  metadata?: Record<string, unknown> | null;

  createdAt: string;
  updatedAt: string;
}

export function createTicketsApi(api: ClientApi) {
  return {
    list(params: Partial<ListTicketsQuery> = {}): Promise<ListResponse<TicketRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<TicketRow>>(`/tickets${query}`);
    },

    get(id: string): Promise<DataResponse<TicketRow>> {
      return api.get<DataResponse<TicketRow>>(`/tickets/${id}`);
    },

    create(data: CreateTicketInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/tickets', data);
    },

    update(id: string, data: UpdateTicketInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/tickets/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/tickets/${id}`);
    },
  };
}
