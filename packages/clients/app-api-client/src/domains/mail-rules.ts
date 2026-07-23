/**
 * App-API mail-rules domain client — flat `/api/mail-rules/*`.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateMailRuleInput,
  UpdateMailRuleInput,
  ListMailRulesQuery,
  ReorderMailRulesInput,
  MailRuleCondition,
  MailRuleAction,
} from '../schemas/mail-rules';

export interface MailRuleRow {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  conditions: MailRuleCondition[];
  matchType: string;
  actions: MailRuleAction[];
  isActive: boolean;
  stopProcessing: boolean | null;
  priority: number | null;
  applyToExisting: boolean | null;
  appliedCount: number | null;
  lastAppliedAt: string | null;
  scope: string | null;
  folders: string[] | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function createMailRulesApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailRulesQuery> = {}): Promise<DataResponse<MailRuleRow[]>> {
      return api.get<DataResponse<MailRuleRow[]>>(
        `/mail-rules${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    get(id: string): Promise<DataResponse<MailRuleRow>> {
      return api.get<DataResponse<MailRuleRow>>(`/mail-rules/${id}`);
    },

    create(data: CreateMailRuleInput): Promise<DataResponse<MailRuleRow>> {
      return api.post<DataResponse<MailRuleRow>>('/mail-rules', data);
    },

    update(id: string, data: UpdateMailRuleInput): Promise<DataResponse<MailRuleRow>> {
      return api.patch<DataResponse<MailRuleRow>>(`/mail-rules/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-rules/${id}`);
    },

    toggle(id: string): Promise<DataResponse<MailRuleRow>> {
      return api.post<DataResponse<MailRuleRow>>(`/mail-rules/${id}/toggle`, {});
    },

    duplicate(id: string): Promise<DataResponse<MailRuleRow>> {
      return api.post<DataResponse<MailRuleRow>>(`/mail-rules/${id}/duplicate`, {});
    },

    reorder(data: ReorderMailRulesInput): Promise<DataResponse<{ updated: number }>> {
      return api.post<DataResponse<{ updated: number }>>('/mail-rules/reorder', data);
    },
  };
}
