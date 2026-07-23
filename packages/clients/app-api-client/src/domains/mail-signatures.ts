/**
 * App-API mail-signatures domain client — flat `/api/mail-signatures/*`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateMailSignatureInput,
  UpdateMailSignatureInput,
  ListMailSignaturesQuery,
} from '../schemas/mail-signatures';

export interface MailSignatureRow {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  accountIds: string[] | null;
  userIds: string[] | null;
  type: string;
  includeInReplies: boolean;
  includeInForwards: boolean;
  position: string;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function createMailSignaturesApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailSignaturesQuery> = {}): Promise<ListResponse<MailSignatureRow>> {
      return api.get<ListResponse<MailSignatureRow>>(
        `/mail-signatures${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<MailSignatureRow>> {
      return api.get<DataResponse<MailSignatureRow>>(`/mail-signatures/${id}`);
    },

    create(data: CreateMailSignatureInput): Promise<DataResponse<MailSignatureRow>> {
      return api.post<DataResponse<MailSignatureRow>>('/mail-signatures', data);
    },

    update(id: string, data: UpdateMailSignatureInput): Promise<DataResponse<MailSignatureRow>> {
      return api.patch<DataResponse<MailSignatureRow>>(`/mail-signatures/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-signatures/${id}`);
    },
  };
}
