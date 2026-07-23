/**
 * App-API mail-drafts domain client — flat `/api/mail-drafts/*`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateMailDraftInput,
  UpdateMailDraftInput,
  ListMailDraftsQuery,
} from '../schemas/mail-drafts';

export interface MailDraftRow {
  id: string;
  accountId: string;
  subject: string | null;
  to: string[] | null;
  cc: string[] | null;
  bcc: string[] | null;
  replyTo: string[] | null;
  body: string | null;
  htmlBody: string | null;
  importance: string | null;
  labels: string[] | null;
  hasAttachments: boolean | null;
  attachmentCount: number | null;
  attachmentIds: string[] | null;
  inReplyTo: string | null;
  originalMessageId: string | null;
  isReply: boolean | null;
  isForward: boolean | null;
  lastAutoSavedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function createMailDraftsApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailDraftsQuery> = {}): Promise<ListResponse<MailDraftRow>> {
      return api.get<ListResponse<MailDraftRow>>(
        `/mail-drafts${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<MailDraftRow>> {
      return api.get<DataResponse<MailDraftRow>>(`/mail-drafts/${id}`);
    },

    create(data: CreateMailDraftInput): Promise<DataResponse<MailDraftRow>> {
      return api.post<DataResponse<MailDraftRow>>('/mail-drafts', data);
    },

    update(id: string, data: UpdateMailDraftInput): Promise<DataResponse<MailDraftRow>> {
      return api.patch<DataResponse<MailDraftRow>>(`/mail-drafts/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-drafts/${id}`);
    },
  };
}
