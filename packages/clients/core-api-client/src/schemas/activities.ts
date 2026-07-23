import { z } from 'zod';

// ============================================================================
// Activities — `/api/activities`.
//
// Backed by `crm_activities`. A CRM activity is a call/email/meeting/task/
// note attached to a contact/customer/lead/opportunity.
// ============================================================================

export const activityType = z.enum([
  'call',
  'email',
  'meeting',
  'task',
  'note',
  'sms',
  'linkedin',
  'demo',
  'presentation',
]);

export const createActivitySchema = z.object({
  type: activityType,
  subject: z.string().min(1).max(255),
  description: z.string().optional(),

  relatedTo: z.string().max(20).optional(),
  relatedToId: z.string().nullish(),
  relatedToName: z.string().max(255).optional(),

  customerId: z.string().nullish(),
  contactId: z.string().nullish(),
  leadId: z.string().nullish(),
  opportunityId: z.string().nullish(),
  assignedToId: z.string().optional(), // defaults to caller userId

  dueDate: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  duration: z.number().int().optional(),

  status: z
    .enum(['planned', 'in_progress', 'completed', 'cancelled', 'deferred'])
    .optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),

  location: z.string().max(500).optional(),
  isVirtual: z.boolean().optional(),
  meetingUrl: z.string().max(1000).optional(),

  callDirection: z.enum(['inbound', 'outbound']).optional(),
  callDuration: z.number().int().optional(),
  callRecordingUrl: z.string().max(1000).optional(),

  emailMessageId: z.string().max(255).nullish(),
  emailSubject: z.string().max(500).optional(),
  emailFrom: z.string().max(255).optional(),
  emailTo: z.array(z.string()).optional(),
  emailCc: z.array(z.string()).optional(),

  attendees: z.array(z.string()).optional(),
  meetingAgenda: z.string().optional(),
  meetingNotes: z.string().optional(),

  outcome: z.string().max(500).optional(),
  nextAction: z.string().max(500).optional(),
  followUpDate: z.string().optional(),

  attachments: z.array(z.string()).optional(),
  calendarEventId: z.string().nullish(),

  isFavorite: z.boolean().optional(),

  tags: z.array(z.string()).optional(),
  customFields: z.unknown().optional(),
});

export const updateActivitySchema = createActivitySchema.partial();

export const listActivitiesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  type: activityType.optional(),
  status: z.string().optional(),
  assignedToId: z.string().optional(),
  customerId: z.string().optional(),
  contactId: z.string().optional(),
  leadId: z.string().optional(),
  opportunityId: z.string().optional(),
  search: z.string().optional(),
});

export type ActivityType = z.infer<typeof activityType>;
export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
export type ListActivitiesQuery = z.infer<typeof listActivitiesQuery>;

export interface Activity {
  id: string;
  type: string;
  subject: string;
  description?: string | null;
  relatedTo?: string | null;
  relatedToId?: string | null;
  relatedToName?: string | null;
  customerId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  opportunityId?: string | null;
  assignedToId: string;
  dueDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  duration?: number | null;
  status: string;
  priority?: string | null;
  location?: string | null;
  isVirtual?: boolean | null;
  meetingUrl?: string | null;
  callDirection?: string | null;
  callDuration?: number | null;
  callRecordingUrl?: string | null;
  outcome?: string | null;
  nextAction?: string | null;
  followUpDate?: string | null;
  tags?: unknown;
  customFields?: unknown;
  createdAt: string;
  updatedAt: string;
}
