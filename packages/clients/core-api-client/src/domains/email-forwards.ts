/**
 * Email forwards API factory (app-api).
 */

import { buildQueryString } from '../types';
import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  ListEmailForwardsQuery,
  CreateEmailForwardInput,
  UpdateEmailForwardInput,
  EmailForward,
} from '../schemas/email-forwards';

export function createEmailForwardsApi(api: ClientApi) {
  return {
    list(params: ListEmailForwardsQuery = {}): Promise<ListResponse<EmailForward>> {
      const qs = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<EmailForward>>(`/email-forwards${qs}`);
    },
    get(id: string): Promise<DataResponse<EmailForward>> {
      return api.get<DataResponse<EmailForward>>(`/email-forwards/${id}`);
    },
    create(input: CreateEmailForwardInput): Promise<DataResponse<EmailForward>> {
      return api.post<DataResponse<EmailForward>>('/email-forwards', input);
    },
    update(id: string, input: UpdateEmailForwardInput): Promise<DataResponse<EmailForward>> {
      return api.patch<DataResponse<EmailForward>>(`/email-forwards/${id}`, input);
    },
    delete(id: string): Promise<void> {
      return api.delete<void>(`/email-forwards/${id}`);
    },
  };
}
