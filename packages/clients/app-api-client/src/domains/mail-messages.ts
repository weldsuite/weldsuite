/**
 * App-API mail-messages domain client — flat `/api/mail-messages/*`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  UpdateMailMessageInput,
  BulkMailMessageActionInput,
  MailMessageLabelsInput,
  ReplyMailMessageInput,
  ForwardMailMessageInput,
  ListMailMessagesQuery,
} from '../schemas/mail-messages';

export interface MailAddress {
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface MailMessageRow {
  id: string;
  accountId: string;
  messageId: string;
  threadId: string | null;
  from: MailAddress | null;
  to: MailAddress[] | null;
  cc: MailAddress[] | null;
  bcc: MailAddress[] | null;
  replyTo: MailAddress | null;
  subject: string | null;
  preview: string | null;
  textBody: string | null;
  htmlBody: string | null;
  sentDate: string | null;
  receivedDate: string | null;
  isRead: boolean;
  isStarred: boolean;
  isFlagged: boolean;
  isImportant: boolean;
  isDraft: boolean;
  isReply: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
  priority: string | null;
  labels: string[] | null;
  sizeBytes: number | null;
  scheduledFor: string | null;
  sendStatus: string | null;
  source: string | null;
  inReplyTo: string | null;
  references: string[] | null;
  externalMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MailMessageWithAttachments extends MailMessageRow {
  attachments: Array<{
    id: string;
    fileName: string;
    contentType: string | null;
    size: number;
    storagePath: string | null;
    isInline: boolean | null;
  }>;
}

export interface MailMessageStats {
  total: number;
  unread: number;
  inboxUnread: number;
  starred: number;
}

export interface MailThread {
  threadId: string;
  messages: MailMessageRow[];
}

export interface ReplyMailResponse {
  messageId: string;
  smtpMessageId: string;
  pendingVerification: boolean;
  repliedTo: string;
}

export interface ForwardMailResponse {
  messageId: string;
  smtpMessageId: string;
  pendingVerification: boolean;
  forwardedFrom: string;
}

export function createMailMessagesApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailMessagesQuery> = {}): Promise<ListResponse<MailMessageRow>> {
      return api.get<ListResponse<MailMessageRow>>(
        `/mail-messages${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    stats(accountId?: string): Promise<DataResponse<MailMessageStats>> {
      return api.get<DataResponse<MailMessageStats>>(
        `/mail-messages/stats${buildQueryString({ accountId })}`,
      );
    },

    get(id: string): Promise<DataResponse<MailMessageWithAttachments>> {
      return api.get<DataResponse<MailMessageWithAttachments>>(`/mail-messages/${id}`);
    },

    thread(messageId: string): Promise<DataResponse<MailThread>> {
      return api.get<DataResponse<MailThread>>(`/mail-messages/${messageId}/thread`);
    },

    update(id: string, data: UpdateMailMessageInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/mail-messages/${id}`, data);
    },

    bulk(data: BulkMailMessageActionInput): Promise<DataResponse<{ affected: number }>> {
      return api.post<DataResponse<{ affected: number }>>('/mail-messages/bulk', data);
    },

    addLabels(
      id: string,
      data: MailMessageLabelsInput,
    ): Promise<DataResponse<{ id: string; labels: string[] }>> {
      return api.post<DataResponse<{ id: string; labels: string[] }>>(
        `/mail-messages/${id}/labels/add`,
        data,
      );
    },

    removeLabels(
      id: string,
      data: MailMessageLabelsInput,
    ): Promise<DataResponse<{ id: string; labels: string[] }>> {
      return api.post<DataResponse<{ id: string; labels: string[] }>>(
        `/mail-messages/${id}/labels/remove`,
        data,
      );
    },

    reply(id: string, data: ReplyMailMessageInput): Promise<DataResponse<ReplyMailResponse>> {
      return api.post<DataResponse<ReplyMailResponse>>(`/mail-messages/${id}/reply`, data);
    },

    forward(id: string, data: ForwardMailMessageInput): Promise<DataResponse<ForwardMailResponse>> {
      return api.post<DataResponse<ForwardMailResponse>>(`/mail-messages/${id}/forward`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-messages/${id}`);
    },
  };
}
