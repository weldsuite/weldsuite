/**
 * App-API mail-campaigns domain client — flat `/api/mail-campaigns/*`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateMailCampaignInput,
  UpdateMailCampaignInput,
  ListMailCampaignsQuery,
  MailCampaignRecipientList,
} from '../schemas/mail-campaigns';

export interface MailCampaignRow {
  id: string;
  templateId: string | null;
  name: string;
  subject: string;
  preheader: string | null;
  htmlContent: string;
  textContent: string | null;
  recipientList: MailCampaignRecipientList;
  totalRecipients: number;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  status: string;
  sentCount: number | null;
  deliveredCount: number | null;
  bouncedCount: number | null;
  openedCount: number | null;
  clickedCount: number | null;
  unsubscribedCount: number | null;
  complaintCount: number | null;
  deliveryRate: number | null;
  openRate: number | null;
  clickRate: number | null;
  bounceRate: number | null;
  unsubscribeRate: number | null;
  isAbTest: boolean | null;
  trackOpens: boolean;
  trackClicks: boolean;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function createMailCampaignsApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailCampaignsQuery> = {}): Promise<ListResponse<MailCampaignRow>> {
      return api.get<ListResponse<MailCampaignRow>>(
        `/mail-campaigns${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<MailCampaignRow>> {
      return api.get<DataResponse<MailCampaignRow>>(`/mail-campaigns/${id}`);
    },

    create(data: CreateMailCampaignInput): Promise<DataResponse<MailCampaignRow>> {
      return api.post<DataResponse<MailCampaignRow>>('/mail-campaigns', data);
    },

    update(id: string, data: UpdateMailCampaignInput): Promise<DataResponse<MailCampaignRow>> {
      return api.patch<DataResponse<MailCampaignRow>>(`/mail-campaigns/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-campaigns/${id}`);
    },
  };
}
