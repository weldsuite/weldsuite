/**
 * App-API project-members domain client — flat /api/project-members/* surface.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateProjectMemberInput,
  UpdateProjectMemberInput,
} from '../schemas/project-members';

export interface ProjectMemberRow {
  id: string;
  projectId: string;
  userId: string;
  role: string | null;
  createdAt: string;
  updatedAt: string;
  /** Server may hydrate the joined workspace member fields when available. */
  name?: string;
  email?: string | null;
  picture?: string | null;
  avatar?: string | null;
}

export interface ListProjectMembersQuery {
  projectId?: string;
  userId?: string;
  limit?: number;
  cursor?: string;
}

export function createProjectMembersApi(api: ClientApi) {
  return {
    list(params: ListProjectMembersQuery = {}): Promise<ListResponse<ProjectMemberRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<ProjectMemberRow>>(`/project-members${query}`);
    },

    create(data: CreateProjectMemberInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/project-members', data);
    },

    update(id: string, data: UpdateProjectMemberInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/project-members/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/project-members/${id}`);
    },
  };
}
