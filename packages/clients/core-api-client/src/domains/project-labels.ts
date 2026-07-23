/**
 * App-API project-labels domain client — flat /api/project-labels/* surface.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateProjectLabelInput,
  UpdateProjectLabelInput,
} from '../schemas/project-labels';

export interface ProjectLabelRow {
  id: string;
  projectId: string | null;
  name: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListProjectLabelsQuery {
  projectId?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export function createProjectLabelsApi(api: ClientApi) {
  return {
    list(params: ListProjectLabelsQuery = {}): Promise<ListResponse<ProjectLabelRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ProjectLabelRow>>(`/project-labels${query}`);
    },

    create(data: CreateProjectLabelInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/project-labels', data);
    },

    update(id: string, data: UpdateProjectLabelInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/project-labels/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/project-labels/${id}`);
    },
  };
}
