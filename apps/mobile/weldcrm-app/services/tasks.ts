/**
 * CRM tasks: the flow-api `tasks` table, filtered to tasks linked to a company
 * or a person (`crmLinked=true`). The same rows as the platform's WeldCRM
 * "My Tasks" page and the Tasks tab on a record.
 *
 *   list    GET    /tasks?crmLinked=true[&assigneeId|customerId|personId|search|cursor]
 *   create  POST   /tasks       { title, …, customerId | personId }
 *   update  PATCH  /tasks/:id   (null clears dueDate, description, repeat, links, assignees)
 *   delete  DELETE /tasks/:id
 */

import type { ApiResponse } from '@weldsuite/mobile-ui/types';
import { appApiClient } from './app-api';
import { query, type Page } from './api';
import type { RecordRef } from './notes';
import { normalizeTaskStatus, type TaskPriority, type TaskRepeat, type TaskStatus } from '@/lib/crm';

export interface TaskPerson {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface CrmTask {
  id: string;
  number?: number;
  title: string;
  description?: string;
  status: TaskStatus;
  /** True for done (and cancelled) tasks. */
  completed: boolean;
  priority?: TaskPriority;
  dueDate?: string;
  labels: string[];
  repeat?: TaskRepeat;
  assignees: TaskPerson[];
  /** The company or person the task is about. */
  record?: RecordRef;
  createdAt: string;
}

export interface TaskInput {
  title?: string;
  /** `null` clears it. */
  description?: string | null;
  status?: TaskStatus;
  /** `null` = no priority (left out on create, as on the web). */
  priority?: TaskPriority | null;
  /** ISO date; `null` clears it. */
  dueDate?: string | null;
  labels?: string[];
  repeat?: TaskRepeat | null;
  /** Clerk user ids; `null` or `[]` unassigns. */
  assigneeIds?: string[] | null;
  /** The company or person; `null` unlinks. */
  record?: RecordRef | null;
}

interface PersonRow {
  id: string;
  name?: string | null;
  avatar?: string | null;
}

interface TaskRow {
  id: string;
  number?: number | null;
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  labels?: string[] | null;
  repeat?: TaskRepeat | null;
  assignee?: PersonRow | null;
  assignees?: PersonRow[] | null;
  customerId?: string | null;
  personId?: string | null;
  contactId?: string | null;
  linkedCompany?: PersonRow | null;
  linkedPerson?: PersonRow | null;
  createdAt: string;
}

interface ListEnvelope<T> {
  data: T[];
  pagination?: { totalCount: number; hasMore: boolean; cursor: string | null };
}

const ok = <T>(data: T): ApiResponse<T> => ({ success: true, data });
const fail = <T>(err: unknown): ApiResponse<T> => ({
  success: false,
  error: err instanceof Error ? err.message : 'Request failed',
});

const PRIORITIES = new Set<string>(['low', 'medium', 'high', 'urgent']);

function toPerson(row: PersonRow): TaskPerson {
  return { id: row.id, name: row.name || '', avatarUrl: row.avatar ?? undefined };
}

export function mapTask(row: TaskRow): CrmTask {
  const status = normalizeTaskStatus(row.status);
  let record: RecordRef | undefined;
  if (row.linkedCompany) record = { kind: 'company', id: row.linkedCompany.id, name: row.linkedCompany.name ?? undefined };
  else if (row.customerId) record = { kind: 'company', id: row.customerId };
  else if (row.linkedPerson) record = { kind: 'person', id: row.linkedPerson.id, name: row.linkedPerson.name ?? undefined };
  else if (row.personId || row.contactId) record = { kind: 'person', id: (row.personId || row.contactId) as string };

  const assignees = (row.assignees?.length ? row.assignees : row.assignee ? [row.assignee] : []).map(toPerson);
  return {
    id: row.id,
    number: row.number ?? undefined,
    title: row.title,
    description: row.description || undefined,
    status,
    completed: status === 'done' || status === 'cancelled',
    priority: row.priority && PRIORITIES.has(row.priority) ? (row.priority as TaskPriority) : undefined,
    dueDate: row.dueDate ?? undefined,
    labels: row.labels ?? [],
    repeat: row.repeat ?? undefined,
    assignees,
    record,
    createdAt: row.createdAt,
  };
}

/** The request body for a create or update; fields that weren't given are left out. */
export function taskPayload(input: TaskInput, mode: 'create' | 'update'): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.title !== undefined) payload.title = input.title.trim();
  if (input.description !== undefined) {
    const text = input.description?.trim();
    if (text) payload.description = text;
    else if (mode === 'update') payload.description = null;
  }
  if (input.status !== undefined) payload.status = input.status;
  // "No priority" is left out, like the platform's dialog does.
  if (input.priority) payload.priority = input.priority;
  if (input.dueDate !== undefined && (input.dueDate !== null || mode === 'update')) payload.dueDate = input.dueDate;
  if (input.labels !== undefined) payload.labels = input.labels;
  if (input.repeat !== undefined && (input.repeat !== null || mode === 'update')) payload.repeat = input.repeat;
  if (input.assigneeIds !== undefined) {
    const ids = input.assigneeIds ?? [];
    if (ids.length > 0) payload.assigneeIds = ids;
    else if (mode === 'update') payload.assigneeIds = null;
  }
  if (input.record !== undefined) {
    // A task links to a company XOR a person.
    const companyId = input.record?.kind === 'company' ? input.record.id : null;
    const personId = input.record?.kind === 'person' ? input.record.id : null;
    if (mode === 'update') {
      payload.customerId = companyId;
      payload.personId = personId;
    } else {
      if (companyId) payload.customerId = companyId;
      if (personId) payload.personId = personId;
    }
  }
  return payload;
}

export const tasksApi = {
  async list(params: {
    cursor?: string | null;
    limit?: number;
    search?: string;
    /** Only tasks assigned to this Clerk user. */
    assigneeId?: string;
    record?: Pick<RecordRef, 'kind' | 'id'>;
  }): Promise<ApiResponse<Page<CrmTask>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<TaskRow>>(
        `/tasks${query({
          crmLinked: true,
          limit: params.limit ?? 100,
          cursor: params.cursor,
          search: params.search?.trim(),
          assigneeId: params.assigneeId,
          customerId: params.record?.kind === 'company' ? params.record.id : undefined,
          personId: params.record?.kind === 'person' ? params.record.id : undefined,
          sortField: 'dueDate',
          sortDirection: 'asc',
        })}`,
      );
      const items = res.data.map(mapTask);
      return ok({
        items,
        totalCount: res.pagination?.totalCount ?? items.length,
        hasMore: res.pagination?.hasMore ?? false,
        cursor: res.pagination?.cursor ?? null,
      });
    } catch (err) {
      return fail(err);
    }
  },

  async get(id: string): Promise<ApiResponse<CrmTask>> {
    try {
      const res = await appApiClient.get<{ data: TaskRow }>(`/tasks/${id}`);
      return ok(mapTask(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async create(input: TaskInput): Promise<ApiResponse<CrmTask>> {
    try {
      const res = await appApiClient.post<{ data: TaskRow }>('/tasks', {
        // A CRM task gets a calendar block like on the web; 30 minutes is the web's default.
        duration: 30,
        ...taskPayload(input, 'create'),
      });
      return ok(mapTask(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  /** Save and read back: the update response only echoes the fields that were sent. */
  async update(id: string, input: TaskInput): Promise<ApiResponse<CrmTask>> {
    try {
      await appApiClient.patch(`/tasks/${id}`, taskPayload(input, 'update'));
      return await tasksApi.get(id);
    } catch (err) {
      return fail(err);
    }
  },

  async remove(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/tasks/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },
};
