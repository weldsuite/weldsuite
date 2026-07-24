import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  MailLabel, ListLabelsQuery, CreateLabelInput, UpdateLabelInput,
  MailAccount, ListAccountsQuery,
} from '../schemas/weldmail';

export function createWeldmailApi(api: ClientApi) {
  return {
    listLabels(params: ListLabelsQuery): Promise<ListResponse<MailLabel>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<MailLabel>>(`/weldmail/labels${query}`);
    },

    getLabel(id: string): Promise<DataResponse<MailLabel>> {
      return api.get<DataResponse<MailLabel>>(`/weldmail/labels/${id}`);
    },

    createLabel(data: CreateLabelInput): Promise<DataResponse<MailLabel>> {
      return api.post<DataResponse<MailLabel>>('/weldmail/labels', data);
    },

    updateLabel(id: string, data: UpdateLabelInput): Promise<DataResponse<MailLabel>> {
      return api.put<DataResponse<MailLabel>>(`/weldmail/labels/${id}`, data);
    },

    // Accounts
    listAccounts(params: ListAccountsQuery = { limit: 50 }): Promise<ListResponse<MailAccount>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<MailAccount>>(`/weldmail/accounts${query}`);
    },

    getAccount(id: string): Promise<DataResponse<MailAccount>> {
      return api.get<DataResponse<MailAccount>>(`/weldmail/accounts/${id}`);
    },
  };
}
