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

/** The company or person a task row points at (a task links to one or the other). */
function recordOfTask(row: TaskRow): RecordRef | undefined {
  if (row.linkedCompany) return { kind: 'company', id: row.linkedCompany.id, name: row.linkedCompany.name ?? undefined };
  if (row.customerId) return { kind: 'company', id: row.customerId };
  if (row.linkedPerson) return { kind: 'person', id: row.linkedPerson.id, name: row.linkedPerson.name ?? undefined };
  const personId = row.personId || row.contactId;
  return personId ? { kind: 'person', id: personId } : undefined;
}

/** All assignees; older rows only have the single `assignee`. */
function assigneesOf(row: TaskRow): TaskPerson[] {
  if (row.assignees?.length) return row.assignees.map(toPerson);
  return row.assignee ? [toPerson(row.assignee)] : [];
}

export function mapTask(row: TaskRow): CrmTask {
  const status = normalizeTaskStatus(row.status);
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
    assignees: assigneesOf(row),
    record: recordOfTask(row),
    createdAt: row.createdAt,
  };
}

type Mode = 'create' | 'update';

/**
 * A clearable field: a value is sent as is; `null` clears it on update and is
 * left out on create (there is nothing to clear yet).
 */
function clearable<T>(payload: Record<string, unknown>, key: string, value: T | null | undefined, mode: Mode) {
  if (value === undefined) return;
  if (value !== null || mode === 'update') payload[key] = value;
}

/** A task links to a company XOR a person; an update always writes both columns. */
function recordLink(payload: Record<string, unknown>, record: RecordRef | null, mode: Mode) {
  const companyId = record?.kind === 'company' ? record.id : null;
  const personId = record?.kind === 'person' ? record.id : null;
  clearable(payload, 'customerId', companyId, mode);
  clearable(payload, 'personId', personId, mode);
}

/** The request body for a create or update; fields that weren't given are left out. */
export function taskPayload(input: TaskInput, mode: Mode): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.title !== undefined) payload.title = input.title.trim();
  if (input.description !== undefined) clearable(payload, 'description', input.description?.trim() || null, mode);
  if (input.status !== undefined) payload.status = input.status;
  // "No priority" is left out, like the platform's dialog does.
  if (input.priority) payload.priority = input.priority;
  clearable(payload, 'dueDate', input.dueDate, mode);
  if (input.labels !== undefined) payload.labels = input.labels;
  clearable(payload, 'repeat', input.repeat, mode);
  if (input.assigneeIds !== undefined) {
    clearable(payload, 'assigneeIds', input.assigneeIds?.length ? input.assigneeIds : null, mode);
  }
  if (input.record !== undefined) recordLink(payload, input.record, mode);
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
