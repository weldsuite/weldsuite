/**
 * App-API mail-accounts domain client — flat `/api/mail-accounts/*`.
 *
 * Includes the compose-send endpoint (`POST /:id/send` → Cloudflare
 * `[[send_email]]` binding) and the shared-account assignment helper.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateMailAccountInput,
  UpdateMailAccountInput,
  ListMailAccountsQuery,
  AssignMailAccountUsersInput,
  SendMailMessageInput,
} from '../schemas/mail-accounts';

export interface MailAccountRow {
  id: string;
  name: string;
  email: string;
  displayName: string | null;
  provider: string;
  authType: string | null;
  status: string;
  isDefault: boolean;
  isShared: boolean;
  assignedUserIds: string[] | null;
  syncEnabled: boolean;
  syncFrequency: number | null;
  syncStatus: string | null;
  lastSyncAt: string | null;
  sentToday: number;
  dailySendLimit: number;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  signature: string | null;
  aiSettings: Record<string, unknown> | null;
  providerConfig: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MailAccountStats {
  total: number;
  active: number;
  inactive: number;
  error: number;
}

export interface MailAccountLabelOption {
  id: string;
  name: string;
  type?: string;
  color?: string | null;
}

export interface SendMailResponse {
  messageId: string;
  smtpMessageId: string;
  pendingVerification: boolean;
  message: string;
}

export function createMailAccountsApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailAccountsQuery> = {}): Promise<ListResponse<MailAccountRow>> {
      return api.get<ListResponse<MailAccountRow>>(
        `/mail-accounts${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    stats(): Promise<DataResponse<MailAccountStats>> {
      return api.get<DataResponse<MailAccountStats>>('/mail-accounts/stats');
    },

    setupLabels(): Promise<DataResponse<MailAccountLabelOption[]>> {
      return api.get<DataResponse<MailAccountLabelOption[]>>('/mail-accounts/setup/labels');
    },

    listLabels(id: string): Promise<DataResponse<MailAccountLabelOption[]>> {
      return api.get<DataResponse<MailAccountLabelOption[]>>(`/mail-accounts/${id}/labels`);
    },

    get(id: string): Promise<DataResponse<MailAccountRow>> {
      return api.get<DataResponse<MailAccountRow>>(`/mail-accounts/${id}`);
    },

    create(data: CreateMailAccountInput): Promise<DataResponse<{ id: string; name: string; email: string }>> {
      return api.post<DataResponse<{ id: string; name: string; email: string }>>('/mail-accounts', data);
    },

    update(id: string, data: UpdateMailAccountInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/mail-accounts/${id}`, data);
    },

    triggerSync(id: string): Promise<DataResponse<{ id: string; syncStatus: string }>> {
      return api.patch<DataResponse<{ id: string; syncStatus: string }>>(`/mail-accounts/${id}/sync`, {});
    },

    assignUsers(
      id: string,
      data: AssignMailAccountUsersInput,
    ): Promise<DataResponse<{ id: string; isShared: boolean; assignedUserIds: string[] }>> {
      return api.patch<DataResponse<{ id: string; isShared: boolean; assignedUserIds: string[] }>>(
        `/mail-accounts/${id}/assign-users`,
        data,
      );
    },

    send(id: string, data: SendMailMessageInput): Promise<DataResponse<SendMailResponse>> {
      return api.post<DataResponse<SendMailResponse>>(`/mail-accounts/${id}/send`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-accounts/${id}`);
    },
  };
}
