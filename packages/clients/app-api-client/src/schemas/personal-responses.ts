/**
 * Response schemas of personal-api (consumer WeldMail and WeldCalendar on a
 * personal account, `apps/workers/personal-api`), matching the interfaces
 * of `@weldsuite/personal-api-client`. The conformance suite checks the
 * Rust port's answers against them (`conformance-schemas-personal.ts`).
 * Rows are Drizzle rows over JSON: timestamps are ISO strings.
 */

import { z } from 'zod';

const timestamp = z.string();
const nullableTimestamp = z.string().nullable();

export const personalAccountSchema = z.object({
  id: z.string(),
  clerkUserId: z.string(),
  displayName: z.string().nullable(),
});

export const personalEntitlementsSchema = z.object({
  plan: z.enum(['free', 'pro']),
  maxAddresses: z.number(),
  dailySendLimit: z.number(),
  calendarPlan: z.enum(['free', 'pro']),
  maxCalendars: z.number(),
  maxBookingPages: z.number(),
});

export const personalMeSchema = z.object({
  account: personalAccountSchema.nullable(),
  mailAccounts: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      displayName: z.string().nullable(),
      provider: z.string(),
      status: z.string(),
      isDefault: z.boolean(),
      createdAt: timestamp,
    }),
  ),
  calendars: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      color: z.string().nullable(),
      isDefault: z.boolean().nullable(),
    }),
  ),
  entitlements: personalEntitlementsSchema,
});

export const personalPushTokenRegisteredSchema = z.object({
  deviceId: z.string(),
  platform: z.enum(['ios', 'android', 'web']),
  registered: z.literal(true),
});

export const personalPushTokenUnregisteredSchema = z.object({
  deviceId: z.string(),
  unregistered: z.literal(true),
});

export const personalIdSchema = z.object({ id: z.string() });

export const personalCalendarSchema = z.object({
  id: z.string(),
  personalAccountId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  ownerId: z.string(),
  isDefault: z.boolean().nullable(),
  isActive: z.boolean().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
  isOwn: z.literal(true),
  permission: z.literal('manage'),
});

const attendeeSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  role: z.string().optional(),
});

export const personalCalendarEventSchema = z.object({
  id: z.string(),
  personalAccountId: z.string(),
  calendarId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  startTime: timestamp,
  endTime: nullableTimestamp,
  allDay: z.boolean().nullable(),
  timezone: z.string().nullable(),
  location: z.string().nullable(),
  isVirtual: z.boolean().nullable(),
  meetingUrl: z.string().nullable(),
  status: z.string(),
  priority: z.string().nullable(),
  color: z.string().nullable(),
  recurrenceRule: z.string().nullable(),
  recurrenceId: z.string().nullable(),
  organizerId: z.string(),
  attendees: z.array(attendeeSchema).nullable(),
  reminders: z.array(z.object({ type: z.string(), minutes: z.number() })).nullable(),
  notes: z.string().nullable(),
  attachments: z.array(z.string()).nullable(),
  tags: z.array(z.string()).nullable(),
  customFields: z.record(z.unknown()).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
});

/** `{ id, ...data }` of an event update: the id and the fields the body set. */
export const personalCalendarEventUpdatedSchema = z.object({ id: z.string() }).passthrough();

export const personalCancelledSchema = z.object({ id: z.string(), status: z.literal('cancelled') });

const range = z.object({ start: z.string(), end: z.string() });

export const personalBookingPageSchema = z.object({
  id: z.string(),
  personalAccountId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  ownerId: z.string(),
  duration: z.number(),
  bufferBefore: z.number().nullable(),
  bufferAfter: z.number().nullable(),
  color: z.string().nullable(),
  isActive: z.boolean().nullable(),
  locationType: z.string().nullable(),
  locationValue: z.string().nullable(),
  availability: z.object({
    monday: z.array(range),
    tuesday: z.array(range),
    wednesday: z.array(range),
    thursday: z.array(range),
    friday: z.array(range),
    saturday: z.array(range),
    sunday: z.array(range),
  }),
  questions: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        type: z.enum(['text', 'textarea', 'select']),
        required: z.boolean(),
        options: z.array(z.string()).optional(),
      }),
    )
    .nullable(),
  minNotice: z.number().nullable(),
  maxAdvance: z.number().nullable(),
  confirmationMessage: z.string().nullable(),
  timezone: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
});

export const personalBookingPageToggledSchema = z.object({ id: z.string(), isActive: z.boolean() });

export const personalTimeSlotSchema = z.object({ start: z.string(), end: z.string(), available: z.boolean() });

export const personalBookingSchema = z.object({
  id: z.string(),
  personalAccountId: z.string(),
  bookingPageId: z.string(),
  calendarEventId: z.string().nullable(),
  bookerName: z.string(),
  bookerEmail: z.string(),
  startTime: timestamp,
  endTime: timestamp,
  status: z.string(),
  answers: z.record(z.unknown()).nullable(),
  notes: z.string().nullable(),
  guests: z.array(z.object({ email: z.string(), name: z.string().optional() })).nullable(),
  timezone: z.string().nullable(),
  cancelledAt: nullableTimestamp,
  cancelReason: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
});

export const personalMailAccountSchema = z.object({
  id: z.string(),
  personalAccountId: z.string(),
  name: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  provider: z.string(),
  status: z.string(),
  signature: z.string().nullable(),
  aiSettings: z.record(z.unknown()).nullable(),
  dailySendLimit: z.number().nullable(),
  sentToday: z.number(),
  isDefault: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
});

export const personalMailLabelSchema = z.object({
  id: z.string(),
  personalAccountId: z.string(),
  accountId: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  isSystem: z.boolean().nullable(),
  slug: z.string().nullable(),
  messageCount: z.number(),
  position: z.number().nullable(),
  aiDescription: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
});

const stringList = z.array(z.string()).nullable();

export const personalMailDraftSchema = z.object({
  id: z.string(),
  personalAccountId: z.string(),
  accountId: z.string(),
  subject: z.string().nullable(),
  to: stringList,
  cc: stringList,
  bcc: stringList,
  replyTo: stringList,
  body: z.string().nullable(),
  htmlBody: z.string().nullable(),
  importance: z.string().nullable(),
  labels: stringList,
  hasAttachments: z.boolean().nullable(),
  attachmentCount: z.number().nullable(),
  attachmentIds: stringList,
  inReplyTo: z.string().nullable(),
  originalMessageId: z.string().nullable(),
  isReply: z.boolean().nullable(),
  isForward: z.boolean().nullable(),
  lastAutoSavedAt: nullableTimestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
});

const address = z.object({ email: z.string(), name: z.string().nullable().optional() }).passthrough();

export const personalMailMessageSchema = z
  .object({
    id: z.string(),
    personalAccountId: z.string(),
    accountId: z.string(),
    messageId: z.string(),
    threadId: z.string().nullable(),
    from: address,
    to: z.array(address),
    cc: z.array(address).nullable(),
    bcc: z.array(address).nullable(),
    replyTo: z.unknown(),
    subject: z.string().nullable(),
    preview: z.string().nullable(),
    textBody: z.string().nullable(),
    htmlBody: z.string().nullable(),
    rawMessage: z.string().nullable(),
    sentDate: timestamp,
    receivedDate: nullableTimestamp,
    isRead: z.boolean(),
    isStarred: z.boolean().nullable(),
    isDraft: z.boolean().nullable(),
    isSpam: z.boolean().nullable(),
    isTrash: z.boolean().nullable(),
    hasAttachments: z.boolean(),
    attachmentCount: z.number().nullable(),
    inReplyTo: z.string().nullable(),
    references: z.array(z.string()).nullable(),
    isReply: z.boolean().nullable(),
    labels: z.array(z.string()).nullable(),
    priority: z.string().nullable(),
    sendStatus: z.string().nullable(),
    sendProvider: z.string().nullable(),
    providerMessageId: z.string().nullable(),
    source: z.string().nullable(),
    idempotencyKey: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: nullableTimestamp,
  })
  .passthrough();

/** A sent message: the SENT copy, whether a recipient must verify, and what it answered or forwarded. */
export const personalSentMessageSchema = personalMailMessageSchema.extend({
  pendingVerification: z.boolean(),
  repliedTo: z.string().optional(),
  forwardedFrom: z.string().optional(),
});

export const personalUnreadCountSchema = z.object({
  total: z.number(),
  byAccount: z.record(z.number()),
});

export const personalMailAttachmentSchema = z
  .object({
    id: z.string(),
    personalAccountId: z.string(),
    messageId: z.string(),
    fileName: z.string(),
    contentType: z.string().nullable(),
    size: z.number(),
    isInline: z.boolean().nullable(),
    contentId: z.string().nullable(),
    downloadUrl: z.string().nullable(),
    storagePath: z.string().nullable(),
    createdAt: timestamp,
  })
  .passthrough();

export const personalMailSubscriptionSchema = z.object({
  id: z.string(),
  personalAccountId: z.string(),
  accountId: z.string(),
  senderEmail: z.string(),
  senderName: z.string().nullable(),
  senderDomain: z.string().nullable(),
  listId: z.string().nullable(),
  unsubscribeUrl: z.string().nullable(),
  unsubscribeMailto: z.string().nullable(),
  oneClick: z.boolean(),
  messageCount: z.number(),
  lastSubject: z.string().nullable(),
  firstReceivedAt: timestamp,
  lastReceivedAt: timestamp,
  status: z.enum(['active', 'unsubscribed']),
  unsubscribeMethod: z.enum(['one_click', 'mailto', 'link']).nullable(),
  unsubscribedAt: nullableTimestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const personalScanResultSchema = z.object({ scanned: z.number(), subscriptions: z.number() });

export const personalUnsubscribeResultSchema = z.object({
  subscription: personalMailSubscriptionSchema,
  method: z.enum(['one_click', 'mailto', 'link']),
  url: z.string().nullable(),
});

export const personalHealthSchema = z.object({
  status: z.literal('ok'),
  environment: z.string(),
  timestamp: z.string(),
});
