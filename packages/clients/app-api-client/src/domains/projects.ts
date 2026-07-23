/**
 * App-API projects domain client — flat /api/projects/* surface.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type { CreateProjectInput, UpdateProjectInput } from '../schemas/projects';

export interface ProjectRow {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  startDate?: string | null;
  endDate?: string | null;
  ownerId?: string | null;
  color?: string | null;
  icon?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListProjectsQuery {
  limit?: number;
  cursor?: string;
  status?: string;
  ownerId?: string;
  search?: string;
}

export function createProjectsApi(api: ClientApi) {
  return {
    list(params: ListProjectsQuery = {}): Promise<ListResponse<ProjectRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ProjectRow>>(`/projects${query}`);
    },

    get(id: string): Promise<DataResponse<ProjectRow>> {
      return api.get<DataResponse<ProjectRow>>(`/projects/${id}`);
    },

    create(data: CreateProjectInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/projects', data);
    },

    update(id: string, data: UpdateProjectInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/projects/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/projects/${id}`);
    },
  };
}
