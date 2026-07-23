import { z } from 'zod';

export const eventFormSchema = z.object({
  calendarId: z.string().min(1, 'Calendar is required'),
  title: z.string().min(1, 'Title is required').max(255),
  description: z.string().optional(),
  type: z.enum(['meeting', 'call', 'appointment', 'event', 'reminder', 'other']).default('meeting'),
  startTime: z.date({ required_error: 'Start time is required' }),
  endTime: z.date().optional().nullable(),
  allDay: z.boolean().default(false),
  location: z.string().optional(),
  isVirtual: z.boolean().default(false),
  meetingUrl: z.string().url('Must be a valid URL').optional().or(z.literal('')),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  color: z.string().optional(),
  attendees: z.array(z.object({
    email: z.string().email(),
    name: z.string().optional(),
  })).optional(),
  customerId: z.string().optional(),
  contactId: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export type EventFormValues = z.infer<typeof eventFormSchema>;

export const EVENT_TYPE_OPTIONS = [
  { label: 'Meeting', value: 'meeting' },
  { label: 'Call', value: 'call' },
  { label: 'Appointment', value: 'appointment' },
  { label: 'Event', value: 'event' },
  { label: 'Reminder', value: 'reminder' },
  { label: 'Other', value: 'other' },
] as const;

export const EVENT_PRIORITY_OPTIONS = [
  { label: 'Low', value: 'low' },
  { label: 'Normal', value: 'normal' },
  { label: 'High', value: 'high' },
  { label: 'Urgent', value: 'urgent' },
] as const;

export const EVENT_STATUS_OPTIONS = [
  { label: 'Confirmed', value: 'confirmed' },
  { label: 'Tentative', value: 'tentative' },
  { label: 'Cancelled', value: 'cancelled' },
] as const;

export const EVENT_TYPE_COLORS: Record<string, string> = {
  meeting: '#3b82f6',     // blue
  call: '#22c55e',        // green
  appointment: '#8b5cf6', // violet
  event: '#f59e0b',       // amber
  reminder: '#ef4444',    // red
  other: '#6b7280',       // gray
};
