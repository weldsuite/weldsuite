/**
 * App-API object templates domain client — flat /api/object-templates/* surface.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  ObjectTemplate,
  CreateObjectTemplateInput,
  UpdateObjectTemplateInput,
  ListObjectTemplatesQuery,
} from '../schemas/object-templates';

export function createObjectTemplatesApi(api: ClientApi) {
  return {
    list(params: Partial<ListObjectTemplatesQuery> = {}): Promise<ListResponse<ObjectTemplate>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ObjectTemplate>>(`/object-templates${query}`);
    },

    get(id: string): Promise<DataResponse<ObjectTemplate>> {
      return api.get<DataResponse<ObjectTemplate>>(`/object-templates/${id}`);
    },

    create(data: CreateObjectTemplateInput): Promise<DataResponse<ObjectTemplate>> {
      return api.post<DataResponse<ObjectTemplate>>('/object-templates', data);
    },

    update(id: string, data: UpdateObjectTemplateInput): Promise<DataResponse<ObjectTemplate>> {
      return api.patch<DataResponse<ObjectTemplate>>(`/object-templates/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/object-templates/${id}`);
    },
  };
}
