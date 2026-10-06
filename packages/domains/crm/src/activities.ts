/**
 * Activities service — the call/email/meeting/task/note audit trail attached
 * to a contact / customer / lead / opportunity (`crm_activities`).
 *
 * Pure business logic; no Hono context. Shared by the crm-api activities
 * routes and WeldConnect's `log_activity` workflow action, so every touch —
 * manual or automated — inserts the same row shape and publishes the same
 * `activity:created` event payload.
 */

import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { CreateActivityInput } from '@weldsuite/core-api-client/schemas/activities';
import type { DataFor } from '@weldsuite/entity-events';

type ActivityEventData = DataFor<'activity'>;
type ActivityInsert = typeof schema.crmActivities.$inferInsert;

export interface CreateActivityResult {
  id: string;
  row: ActivityInsert;
  eventData: ActivityEventData;
}

/**
 * Insert an activity row. `assignedToId` defaults to `actingUserId` when the
 * input doesn't specify one — the CRM route's caller for a normal create, or
 * the workflow's owner for WeldConnect's `log_activity` step.
 */
export async function createActivity(
  db: Database,
  input: CreateActivityInput,
  actingUserId?: string,
): Promise<CreateActivityResult> {
  const { crmActivities: t } = schema;
  const assignedToId = input.assignedToId ?? actingUserId;
  if (!assignedToId) throw new Error('assignedToId required');
  const id = generateId('act');
  const now = new Date();
  const values: ActivityInsert = {
    id,
    type: input.type,
    subject: input.subject,
    description: input.description,
    relatedTo: input.relatedTo,
    relatedToId: input.relatedToId,
    relatedToName: input.relatedToName,
    customerId: input.customerId,
    contactId: input.contactId,
    personId: input.personId,
    leadId: input.leadId,
    opportunityId: input.opportunityId,
    assignedToId,
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
    startTime: input.startTime ? new Date(input.startTime) : undefined,
    endTime: input.endTime ? new Date(input.endTime) : undefined,
    duration: input.duration,
    status: input.status ?? 'planned',
    priority: input.priority ?? 'medium',
    location: input.location,
    isVirtual: input.isVirtual,
    meetingUrl: input.meetingUrl,
    callDirection: input.callDirection,
    callDuration: input.callDuration,
    callRecordingUrl: input.callRecordingUrl,
    emailMessageId: input.emailMessageId,
    emailSubject: input.emailSubject,
    emailFrom: input.emailFrom,
    emailTo: input.emailTo,
    emailCc: input.emailCc,
    attendees: input.attendees,
    meetingAgenda: input.meetingAgenda,
    meetingNotes: input.meetingNotes,
    outcome: input.outcome,
    nextAction: input.nextAction,
    followUpDate: input.followUpDate ? new Date(input.followUpDate) : undefined,
    attachments: input.attachments,
    calendarEventId: input.calendarEventId,
    tags: input.tags,
    customFields: input.customFields as Record<string, unknown> | null | undefined,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(t).values(values);
  const eventData: ActivityEventData = {
    id,
    type: values.type,
    subject: values.subject,
    status: values.status,
    customerId: values.customerId,
    contactId: values.contactId,
    assigneeId: values.assignedToId,
    dueDate: values.dueDate ? new Date(values.dueDate).toISOString() : null,
  };
  return { id, row: values, eventData };
}
