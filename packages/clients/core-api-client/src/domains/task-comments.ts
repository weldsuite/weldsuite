/**
 * App-API task-comments domain client — flat /api/task-comments/* surface.
 *
 * The DB column is `body` (matches the schema). UI components that historically
 * called the field `content` are responsible for mapping it; the API itself is
 * the source of truth.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateTaskCommentInput,
  UpdateTaskCommentInput,
} from '../schemas/task-comments';

export interface TaskCommentRow {
  id: string;
  taskId: string;
  authorId: string | null;
  body: string;
  mentions?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListTaskCommentsQuery {
  taskId?: string;
  authorId?: string;
  limit?: number;
  cursor?: string;
}

export function createTaskCommentsApi(api: ClientApi) {
  return {
    list(params: ListTaskCommentsQuery = {}): Promise<ListResponse<TaskCommentRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<TaskCommentRow>>(`/task-comments${query}`);
    },

    create(data: CreateTaskCommentInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/task-comments', data);
    },

    update(id: string, data: UpdateTaskCommentInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/task-comments/${id}`, data);
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/task-comments/${id}`);
    },
  };
}
