/**
 * App-API mail-snooze domain client — flat `/api/mail-snooze/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type { MailAddress } from './mail-messages';
import type {
  SnoozeMessageInput,
  ResnoozeMessageInput,
  ListSnoozedMessagesQuery,
} from '../schemas/mail-snooze';

export interface SnoozedMessageSummary {
  id: string;
  accountId: string;
  subject: string | null;
  from: MailAddress | null;
  snoozedUntil: string | null;
  snoozedAt: string | null;
  triggerRunId: string | null;
  createdAt: string | null;
}

export interface SnoozeResult {
  id: string;
  snoozedUntil: string;
}

export function createMailSnoozeApi(api: ClientApi) {
  return {
    listSnoozed(
      params: Partial<ListSnoozedMessagesQuery> = {},
    ): Promise<DataResponse<SnoozedMessageSummary[]>> {
      return api.get<DataResponse<SnoozedMessageSummary[]>>(
        `/mail-snooze/snoozed${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    snooze(
      accountId: string,
      messageId: string,
      data: SnoozeMessageInput,
    ): Promise<DataResponse<SnoozeResult>> {
      return api.post<DataResponse<SnoozeResult>>(
        `/mail-snooze/accounts/${accountId}/messages/${messageId}/snooze`,
        data,
      );
    },

    unsnooze(
      accountId: string,
      messageId: string,
    ): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(
        `/mail-snooze/accounts/${accountId}/messages/${messageId}/unsnooze`,
        {},
      );
    },

    resnooze(
      accountId: string,
      messageId: string,
      data: ResnoozeMessageInput,
    ): Promise<DataResponse<SnoozeResult>> {
      return api.post<DataResponse<SnoozeResult>>(
        `/mail-snooze/accounts/${accountId}/messages/${messageId}/resnooze`,
        data,
      );
    },
  };
}
