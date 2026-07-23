/**
 * App-API mail-scheduled domain client — flat `/api/mail-scheduled/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type { MailMessageRow } from './mail-messages';
import type {
  ScheduleMailInput,
  RescheduleMailInput,
  ListMailScheduledQuery,
} from '../schemas/mail-scheduled';

export interface ScheduleMailResult {
  messageId: string;
  smtpMessageId: string;
  scheduledFor: string;
  triggerRunId: string;
}

export interface RescheduleMailResult {
  scheduledFor: string;
  triggerRunId: string;
}

export function createMailScheduledApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailScheduledQuery> = {}): Promise<DataResponse<MailMessageRow[]>> {
      return api.get<DataResponse<MailMessageRow[]>>(
        `/mail-scheduled${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    schedule(data: ScheduleMailInput): Promise<DataResponse<ScheduleMailResult>> {
      return api.post<DataResponse<ScheduleMailResult>>('/mail-scheduled', data);
    },

    cancel(messageId: string): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>(`/mail-scheduled/${messageId}/cancel`, {});
    },

    reschedule(
      messageId: string,
      data: RescheduleMailInput,
    ): Promise<DataResponse<RescheduleMailResult>> {
      return api.post<DataResponse<RescheduleMailResult>>(
        `/mail-scheduled/${messageId}/reschedule`,
        data,
      );
    },

    sendNow(messageId: string): Promise<DataResponse<{ id: string; externalMessageId: string }>> {
      return api.post<DataResponse<{ id: string; externalMessageId: string }>>(
        `/mail-scheduled/${messageId}/send-now`,
        {},
      );
    },
  };
}
