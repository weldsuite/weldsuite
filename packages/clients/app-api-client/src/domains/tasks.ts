/**
 * App-API tasks domain client — flat /api/tasks/* surface.
 *
 * Backs the object-based task panel and any future task-centric UI that
 * needs to read/write the canonical `tasks` table without going through
 * the legacy per-project nesting of the older api-worker.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type { CreateTaskInput, UpdateTaskInput, MoveTaskInput } from '../schemas/tasks';

export interface TaskRow {
  id: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  sprintId?: string | null;
  milestoneId?: string | null;
  parentTaskId?: string | null;
  stageId?: string | null;
  customerId?: string | null;
  contactId?: string | null;
  status: string;
  priority: string;
  type?: string | null;
  category?: string | null;
  tags?: string[] | null;
  labels?: string[] | null;
  assigneeId?: string | null;
  assigneeIds?: string[] | null;
  reporterId?: string | null;
  watchers?: string[] | null;
  startDate?: string | null;
  dueDate?: string | null;
  completedDate?: string | null;
  estimatedHours?: string | number | null;
  actualHours?: string | number | null;
  duration?: number | null;
  storyPoints?: number | null;
  dependsOn?: string[] | null;
  blocks?: string[] | null;
  position?: number;
  boardPosition?: number | null;
  repeat?: {
    frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
    interval?: number;
    unit?: 'days' | 'weeks' | 'months' | 'years';
  } | null;
  customFields?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAttachmentRow {
  id: string;
  fileName: string;
  fileKey: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export interface ListTasksQuery {
  limit?: number;
  cursor?: string;
  projectId?: string;
  sprintId?: string;
  milestoneId?: string;
  parentTaskId?: string;
  assigneeId?: string;
  status?: string;
  priority?: string;
  search?: string;
}

export function createTasksApi(api: ClientApi) {
  return {
    list(params: ListTasksQuery = {}): Promise<ListResponse<TaskRow>> {
      const query = buildQueryString(params as Record<string, unknown>);
      return api.get<ListResponse<TaskRow>>(`/tasks${query}`);
    },

    get(id: string): Promise<DataResponse<TaskRow>> {
      return api.get<DataResponse<TaskRow>>(`/tasks/${id}`);
    },

    create(data: CreateTaskInput): Promise<DataResponse<{ id: string }>> {
      return api.post<DataResponse<{ id: string }>>('/tasks', data);
    },

    update(id: string, data: UpdateTaskInput): Promise<DataResponse<{ id: string }>> {
      return api.patch<DataResponse<{ id: string }>>(`/tasks/${id}`, data);
    },

    /**
     * Move a task (and its subtasks) to another project. Clears & resets the
     * task's project-scoped references to the destination project's defaults.
     * Returns the moved task id + number of subtasks moved with it.
     */
    move(
      id: string,
      data: MoveTaskInput,
    ): Promise<DataResponse<{ id: string; projectId: string; movedSubtaskCount: number }>> {
      return api.post<DataResponse<{ id: string; projectId: string; movedSubtaskCount: number }>>(
        `/tasks/${id}/move`,
        data,
      );
    },

    delete(id: string): Promise<void> {
      return api.delete<void>(`/tasks/${id}`);
    },

    /**
     * Task attachments are `files` rows (entityType='task'). These endpoints are
     * gated by `tasks:update` — attaching to a task is editing it — rather than
     * the generic Drive `files:*` perms, which a normal contributor lacks for
     * deletion. Add returns the persisted row (real id) so callers can reconcile
     * an optimistic entry.
     */
    addAttachment(
      taskId: string,
      data: { fileName: string; fileKey: string; fileSize: number; mimeType: string; url?: string },
    ): Promise<DataResponse<TaskAttachmentRow>> {
      return api.post<DataResponse<TaskAttachmentRow>>(`/tasks/${taskId}/attachments`, data);
    },

    removeAttachment(taskId: string, fileId: string): Promise<void> {
      return api.delete<void>(`/tasks/${taskId}/attachments/${fileId}`);
    },
  };
}
