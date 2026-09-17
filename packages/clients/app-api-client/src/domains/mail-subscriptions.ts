/**
 * App-API mail-subscriptions domain client — flat `/api/mail-subscriptions/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  ListMailSubscriptionsQuery,
  MailSubscriptionStatus,
  ScanMailSubscriptionsInput,
} from '../schemas/mail-subscriptions';

export type MailUnsubscribeMethod = 'one_click' | 'mailto' | 'link';

export interface MailSubscription {
  id: string;
  accountId: string;
  senderEmail: string;
  senderName: string | null;
  senderDomain: string | null;
  listId: string | null;
  unsubscribeUrl: string | null;
  unsubscribeMailto: string | null;
  oneClick: boolean;
  messageCount: number;
  lastSubject: string | null;
  firstReceivedAt: string;
  lastReceivedAt: string;
  status: MailSubscriptionStatus;
  unsubscribeMethod: MailUnsubscribeMethod | null;
  unsubscribedAt: string | null;
  unsubscribedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScanMailSubscriptionsResult {
  scanned: number;
  subscriptions: number;
}

export interface UnsubscribeResult {
  subscription: MailSubscription;
  method: MailUnsubscribeMethod;
  /** For `link`: the page to open so the user can finish unsubscribing. */
  url: string | null;
}

export function createMailSubscriptionsApi(api: ClientApi) {
  return {
    list(params: ListMailSubscriptionsQuery): Promise<DataResponse<MailSubscription[]>> {
      return api.get<DataResponse<MailSubscription[]>>(
        `/mail-subscriptions${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    scan(data: ScanMailSubscriptionsInput): Promise<DataResponse<ScanMailSubscriptionsResult>> {
      return api.post<DataResponse<ScanMailSubscriptionsResult>>('/mail-subscriptions/scan', data);
    },

    unsubscribe(id: string): Promise<DataResponse<UnsubscribeResult>> {
      return api.post<DataResponse<UnsubscribeResult>>(`/mail-subscriptions/${id}/unsubscribe`, {});
    },
  };
}
