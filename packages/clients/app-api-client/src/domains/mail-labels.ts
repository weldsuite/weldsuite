/**
 * App-API mail-labels domain client — flat `/api/mail-labels/*`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type { MailMessageRow } from './mail-messages';
import type {
  CreateMailLabelInput,
  UpdateMailLabelInput,
  ListMailLabelsQuery,
  ApplyLabelToMessagesInput,
  ApplyLabelToThreadInput,
  ListMailLabelThreadsQuery,
} from '../schemas/mail-labels';

export interface MailLabelRow {
  id: string;
  accountId: string;
  name: string;
  color: string | null;
  isSystem: boolean | null;
  slug: string | null;
  messageCount: number;
  position: number | null;
  aiEnabled: boolean | null;
  aiKeywords: string[] | null;
  aiDescription: string | null;
  aiConfidence: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MailThreadSummary {
  threadId: string;
  accountId: string;
  subject: string;
  participants: string[];
  latestMessageId: string;
  latestSender: string;
  latestSenderEmail: string;
  latestSenderAvatarUrl: string | null;
  latestDate: string | null;
  preview: string;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  isStarred: boolean;
  labels: string[];
  scheduledFor: string | null;
  sendStatus: string | null;
  messages: MailMessageRow[];
}

/** Note: the legacy api-worker returned `{ data: MailLabelRow[] }` directly — no
 *  cursor pagination — so the list response is `DataResponse<...>`, not
 *  `ListResponse<...>`. We keep wire compat for the frontend cutover. */
export function createMailLabelsApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailLabelsQuery> = {}): Promise<DataResponse<MailLabelRow[]>> {
      return api.get<DataResponse<MailLabelRow[]>>(
        `/mail-labels${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<MailLabelRow>> {
      return api.get<DataResponse<MailLabelRow>>(`/mail-labels/${id}`);
    },

    create(data: CreateMailLabelInput): Promise<DataResponse<MailLabelRow>> {
      return api.post<DataResponse<MailLabelRow>>('/mail-labels', data);
    },

    update(id: string, data: UpdateMailLabelInput): Promise<DataResponse<MailLabelRow>> {
      return api.patch<DataResponse<MailLabelRow>>(`/mail-labels/${id}`, data);
    },

    delete(id: string): Promise<DataResponse<{ id: string; deleted: true }>> {
      return api.delete<DataResponse<{ id: string; deleted: true }>>(`/mail-labels/${id}`);
    },

    addToMessages(data: ApplyLabelToMessagesInput): Promise<DataResponse<{ count: number }>> {
      return api.post<DataResponse<{ count: number }>>('/mail-labels/add-to-messages', data);
    },

    removeFromMessages(data: ApplyLabelToMessagesInput): Promise<DataResponse<{ count: number }>> {
      return api.post<DataResponse<{ count: number }>>('/mail-labels/remove-from-messages', data);
    },

    applyToThread(
      data: ApplyLabelToThreadInput,
    ): Promise<DataResponse<{ affected: number; action: 'add' | 'remove' }>> {
      return api.post<DataResponse<{ affected: number; action: 'add' | 'remove' }>>(
        '/mail-labels/apply-to-thread',
        data,
      );
    },

    threads(
      params: ListMailLabelThreadsQuery,
    ): Promise<DataResponse<{ threads: MailThreadSummary[]; totalCount: number }>> {
      return api.get<DataResponse<{ threads: MailThreadSummary[]; totalCount: number }>>(
        `/mail-labels/threads${buildQueryString(params as Record<string, unknown>)}`,
      );
    },
  };
}
