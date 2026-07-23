/**
 * App-API mail-templates domain client — flat `/api/mail-templates/*`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateMailTemplateInput,
  UpdateMailTemplateInput,
  ListMailTemplatesQuery,
  RenderMailTemplateInput,
  MailTemplateVariable,
} from '../schemas/mail-templates';

export interface MailTemplateRow {
  id: string;
  name: string;
  subject: string;
  htmlContent: string;
  textContent: string | null;
  category: string | null;
  description: string | null;
  variables: MailTemplateVariable[] | null;
  requiredVariables: string[] | null;
  type: string;
  purpose: string | null;
  usageCount: number | null;
  lastUsedAt: string | null;
  isActive: boolean;
  isDefault: boolean | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MailTemplateRenderResult {
  subject: string;
  htmlContent: string;
  textContent: string | null;
}

export function createMailTemplatesApi(api: ClientApi) {
  return {
    list(params: Partial<ListMailTemplatesQuery> = {}): Promise<ListResponse<MailTemplateRow>> {
      return api.get<ListResponse<MailTemplateRow>>(
        `/mail-templates${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    categories(): Promise<DataResponse<string[]>> {
      return api.get<DataResponse<string[]>>('/mail-templates/categories');
    },

    get(id: string): Promise<DataResponse<MailTemplateRow>> {
      return api.get<DataResponse<MailTemplateRow>>(`/mail-templates/${id}`);
    },

    create(data: CreateMailTemplateInput): Promise<DataResponse<MailTemplateRow>> {
      return api.post<DataResponse<MailTemplateRow>>('/mail-templates', data);
    },

    update(id: string, data: UpdateMailTemplateInput): Promise<DataResponse<MailTemplateRow>> {
      return api.patch<DataResponse<MailTemplateRow>>(`/mail-templates/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/mail-templates/${id}`);
    },

    duplicate(id: string): Promise<DataResponse<MailTemplateRow>> {
      return api.post<DataResponse<MailTemplateRow>>(`/mail-templates/${id}/duplicate`, {});
    },

    render(
      id: string,
      data: RenderMailTemplateInput,
    ): Promise<DataResponse<MailTemplateRenderResult>> {
      return api.post<DataResponse<MailTemplateRenderResult>>(
        `/mail-templates/${id}/render`,
        data,
      );
    },
  };
}
