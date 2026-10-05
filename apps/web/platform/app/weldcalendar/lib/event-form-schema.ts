import { z } from 'zod';

/** Messages of the schema's validation rules (translated by the caller). */
export interface EventFormMessages {
  calendarRequired: string;
  titleRequired: string;
  titleTooLong: string;
  startRequired: string;
  invalidMeetingUrl: string;
  invalidGuestEmail: string;
}

const DEFAULT_MESSAGES: EventFormMessages = {
  calendarRequired: 'Calendar is required',
  titleRequired: 'Title is required',
  titleTooLong: 'Title is too long',
  startRequired: 'Start time is required',
  invalidMeetingUrl: 'Must be a valid URL',
  invalidGuestEmail: 'Invalid email address',
};

export const EVENT_TYPE_VALUES = ['meeting', 'call', 'appointment', 'event', 'reminder', 'other'] as const;
export const EVENT_PRIORITY_VALUES = ['low', 'normal', 'high', 'urgent'] as const;
export const EVENT_STATUS_VALUES = ['confirmed', 'tentative', 'cancelled'] as const;

/**
 * The edit dialog's schema. The API returns `null` for every column that was
 * never set (`tags`, `attendees`, `customerId`, ...). Optional fields therefore
 * accept null as well as undefined: a strict `.optional()` rejects null and,
 * because the dialog seeds the form from the stored event, made "Update" fail
 * validation silently.
 *
 * A factory so the messages can be translated: `buildEventFormSchema(msgs)` with
 * the `weldcalendar` locale strings; `eventFormSchema` (English) is the type
 * source and the default for callers that do not translate.
 */
export function buildEventFormSchema(messages: EventFormMessages = DEFAULT_MESSAGES) {
  return z.object({
    calendarId: z.string().min(1, messages.calendarRequired),
    title: z.string().min(1, messages.titleRequired).max(255, messages.titleTooLong),
    description: z.string().nullish(),
    type: z.enum(EVENT_TYPE_VALUES).default('meeting'),
    startTime: z.date({ required_error: messages.startRequired, invalid_type_error: messages.startRequired }),
    endTime: z.date().optional().nullable(),
    allDay: z.boolean().default(false),
    location: z.string().nullish(),
    isVirtual: z.boolean().default(false),
    meetingUrl: z.string().url(messages.invalidMeetingUrl).nullish().or(z.literal('')),
    status: z.enum(EVENT_STATUS_VALUES).default('confirmed'),
    priority: z.enum(EVENT_PRIORITY_VALUES).default('normal'),
    color: z.string().nullish(),
    attendees: z.array(z.object({
      email: z.string().email(messages.invalidGuestEmail),
      name: z.string().nullish(),
      status: z.string().nullish(),
      role: z.string().nullish(),
    })).nullish(),
    customerId: z.string().nullish(),
    contactId: z.string().nullish(),
    notes: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
  });
}

export const eventFormSchema = buildEventFormSchema();

export type EventFormValues = z.infer<typeof eventFormSchema>;
// The schema applies `.default()` on several fields, so `zodResolver` types the
// form's raw (pre-submit) values as the narrower input shape — those fields
// are optional until Zod fills them in. `useForm`'s TFieldValues must match.
export type EventFormInput = z.input<typeof eventFormSchema>;

export type EventTypeValue = (typeof EVENT_TYPE_VALUES)[number];
export type EventPriorityValue = (typeof EVENT_PRIORITY_VALUES)[number];
export type EventStatusValue = (typeof EVENT_STATUS_VALUES)[number];

/**
 * The `weldcalendar` locale strings the type / priority / status names come
 * from. They are the same keys the toolbar filter uses, so one type has one name
 * everywhere (`reminder` is "Task" in the filter and so in the panel and the
 * dialog too). `t.calendarView` satisfies this.
 */
export interface EventOptionLabels {
  filterTypeMeeting: string;
  filterTypeCall: string;
  filterTypeAppointment: string;
  filterTypeEvent: string;
  filterTypeTask: string;
  filterTypeOther: string;
  filterPriorityLow: string;
  filterPriorityNormal: string;
  filterPriorityHigh: string;
  filterPriorityUrgent: string;
  filterStatusConfirmed: string;
  filterStatusTentative: string;
  filterStatusCancelled: string;
}

export interface EventOption<V extends string> {
  label: string;
  value: V;
}

export function getEventTypeLabels(labels: EventOptionLabels): Record<EventTypeValue, string> {
  return {
    meeting: labels.filterTypeMeeting,
    call: labels.filterTypeCall,
    appointment: labels.filterTypeAppointment,
    event: labels.filterTypeEvent,
    reminder: labels.filterTypeTask,
    other: labels.filterTypeOther,
  };
}

export function getEventPriorityLabels(labels: EventOptionLabels): Record<EventPriorityValue, string> {
  return {
    low: labels.filterPriorityLow,
    normal: labels.filterPriorityNormal,
    high: labels.filterPriorityHigh,
    urgent: labels.filterPriorityUrgent,
  };
}

export function getEventStatusLabels(labels: EventOptionLabels): Record<EventStatusValue, string> {
  return {
    confirmed: labels.filterStatusConfirmed,
    tentative: labels.filterStatusTentative,
    cancelled: labels.filterStatusCancelled,
  };
}

export function getEventTypeOptions(labels: EventOptionLabels): EventOption<EventTypeValue>[] {
  const names = getEventTypeLabels(labels);
  return EVENT_TYPE_VALUES.map((value) => ({ value, label: names[value] }));
}

export function getEventPriorityOptions(labels: EventOptionLabels): EventOption<EventPriorityValue>[] {
  const names = getEventPriorityLabels(labels);
  return EVENT_PRIORITY_VALUES.map((value) => ({ value, label: names[value] }));
}

export function getEventStatusOptions(labels: EventOptionLabels): EventOption<EventStatusValue>[] {
  const names = getEventStatusLabels(labels);
  return EVENT_STATUS_VALUES.map((value) => ({ value, label: names[value] }));
}

/** Name of a stored value; an unknown one (data written by another client) is shown as is. */
export function labelFor(names: Record<string, string>, value: string | null | undefined): string {
  if (!value) return '';
  return names[value] ?? value;
}

export const EVENT_TYPE_COLORS: Record<string, string> = {
  meeting: '#3b82f6',     // blue
  call: '#22c55e',        // green
  appointment: '#8b5cf6', // violet
  event: '#f59e0b',       // amber
  reminder: '#ef4444',    // red
  other: '#6b7280',       // gray
};
