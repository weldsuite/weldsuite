import type { UpdateTaskInput } from '@weldsuite/app-api-client/schemas/tasks';
import type { TaskUpdateData } from '@/components/task-detail';

/** A date edit as the API takes it: an ISO string, or `null` when the user cleared it. */
function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** A task links to a company OR a person: setting one clears the other. */
function linkPayload(data: TaskUpdateData): Pick<UpdateTaskInput, 'customerId' | 'personId'> {
  const link: Pick<UpdateTaskInput, 'customerId' | 'personId'> = {};
  if (data.linkedCompany !== undefined) {
    link.customerId = data.linkedCompany?.id ?? null;
    if (data.linkedCompany) link.personId = null;
  }
  if (data.linkedPerson !== undefined) {
    link.personId = data.linkedPerson?.id ?? null;
    if (data.linkedPerson) link.customerId = null;
  }
  return link;
}

/** The assignee fields of an edit; `assignees` (a full list) wins over a single `assignee`. */
function assigneePayload(data: TaskUpdateData): Pick<UpdateTaskInput, 'assigneeId' | 'assigneeIds'> {
  if (data.assignees !== undefined) {
    const ids = (data.assignees ?? []).map((a) => a.id).filter(Boolean);
    return { assigneeIds: ids, assigneeId: ids[0] ?? null };
  }
  if (data.assignee !== undefined) return { assigneeId: data.assignee?.id ?? null };
  return {};
}

/**
 * The PATCH body for an edit made in the task panel. `undefined` leaves a field
 * alone; `null` (a cleared due / start date, a removed recurrence or link) is
 * sent as an explicit `null`, because JSON drops `undefined` and the stored
 * value would otherwise stay.
 */
export function buildTaskUpdatePayload(data: TaskUpdateData): UpdateTaskInput {
  const payload: UpdateTaskInput = {};
  if (data.title !== undefined) payload.title = data.title;
  if (data.description !== undefined) payload.description = data.description;
  if (data.status !== undefined) payload.status = data.status;
  if (data.priority !== undefined) payload.priority = data.priority;
  if (data.dueDate !== undefined) payload.dueDate = isoOrNull(data.dueDate);
  if (data.startDate !== undefined) payload.startDate = isoOrNull(data.startDate);
  if (data.duration !== undefined) payload.duration = data.duration;
  if (data.labels !== undefined) payload.labels = data.labels;
  if (data.repeat !== undefined) payload.repeat = data.repeat || null;
  if (data.customFields !== undefined) payload.customFields = data.customFields;
  return Object.assign(payload, linkPayload(data), assigneePayload(data));
}
