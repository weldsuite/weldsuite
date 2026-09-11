/** Error payload from personal-api: `{ error: { code, message } }`. */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface PersonalAccount {
  id: string;
  clerkUserId: string;
  displayName: string | null;
}

export interface MailAccount {
  id: string;
  personalAccountId?: string;
  name: string;
  email: string;
  displayName?: string | null;
  provider?: string;
  status?: string;
  isDefault?: boolean;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface MailEmailAddress {
  email: string;
  name?: string;
  type?: string;
}

export interface MailMessage {
  id: string;
  personalAccountId: string;
  accountId: string;
  messageId: string;
  threadId?: string | null;
  from: MailEmailAddress;
  to: MailEmailAddress[];
  cc?: MailEmailAddress[] | null;
  bcc?: MailEmailAddress[] | null;
  replyTo?: MailEmailAddress | null;
  subject?: string | null;
  preview?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  sentDate: string | Date;
  receivedDate?: string | Date | null;
  isRead: boolean;
  isStarred?: boolean | null;
  isDraft?: boolean | null;
  isSpam?: boolean | null;
  isTrash?: boolean | null;
  hasAttachments: boolean;
  attachmentCount?: number | null;
  inReplyTo?: string | null;
  references?: string[] | null;
  isReply?: boolean | null;
  labels?: string[] | null;
  sendStatus?: string | null;
  source?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  /** Present on send/reply/forward responses when a recipient must verify. */
  pendingVerification?: boolean;
}

export interface MailAttachment {
  id: string;
  personalAccountId: string;
  messageId: string;
  fileName: string;
  contentType?: string | null;
  size: number;
  isInline?: boolean | null;
  contentId?: string | null;
  downloadUrl?: string | null;
  storagePath?: string | null;
  createdAt?: string | Date;
}

/** Unread totals for the inbox badge. */
export interface UnreadCount {
  total: number;
  byAccount: Record<string, number>;
}

export interface MailLabel {
  id: string;
  personalAccountId: string;
  accountId: string;
  name: string;
  color?: string | null;
  isSystem?: boolean | null;
  slug?: string | null;
  messageCount: number;
  position?: number | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface MailDraft {
  id: string;
  personalAccountId: string;
  accountId: string;
  subject?: string | null;
  to?: string[] | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  replyTo?: string[] | null;
  body?: string | null;
  htmlBody?: string | null;
  importance?: string | null;
  labels?: string[] | null;
  hasAttachments?: boolean | null;
  attachmentCount?: number | null;
  attachmentIds?: string[] | null;
  inReplyTo?: string | null;
  originalMessageId?: string | null;
  isReply?: boolean | null;
  isForward?: boolean | null;
  lastAutoSavedAt?: string | Date | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface PaginationMeta {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export interface DataResponse<T> {
  data: T;
}

export interface ListResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface MeResponse {
  account: PersonalAccount | null;
  mailAccounts: MailAccount[];
  calendars?: CalendarSummary[];
  entitlements?: PersonalEntitlements;
}

export interface PersonalEntitlements {
  plan: 'free' | 'pro';
  maxAddresses: number;
  dailySendLimit: number;
  calendarPlan?: 'free' | 'pro';
  maxCalendars?: number;
  maxBookingPages?: number;
}

export interface CalendarSummary {
  id: string;
  name: string;
  color?: string | null;
  isDefault?: boolean | null;
}

export interface Calendar {
  id: string;
  personalAccountId?: string;
  name: string;
  description?: string | null;
  color?: string | null;
  ownerId: string;
  isDefault?: boolean | null;
  isActive?: boolean | null;
  isOwn?: boolean;
  permission?: 'view' | 'edit' | 'manage';
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CalendarEventAttendee {
  email: string;
  name?: string;
  status?: string;
  role?: string;
}

export interface CalendarEvent {
  id: string;
  personalAccountId?: string;
  calendarId: string;
  title: string;
  description?: string | null;
  type: string;
  startTime: string | Date;
  endTime?: string | Date | null;
  allDay?: boolean | null;
  timezone?: string | null;
  location?: string | null;
  isVirtual?: boolean | null;
  meetingUrl?: string | null;
  status: string;
  priority?: string | null;
  color?: string | null;
  recurrenceRule?: string | null;
  recurrenceId?: string | null;
  organizerId: string;
  attendees?: CalendarEventAttendee[] | null;
  reminders?: { type: 'email' | 'notification'; minutes: number }[] | null;
  notes?: string | null;
  tags?: string[] | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CreateCalendarInput {
  name: string;
  description?: string;
  color?: string;
}

export interface CreateEventInput {
  calendarId: string;
  title: string;
  description?: string;
  type?: 'meeting' | 'call' | 'appointment' | 'event' | 'reminder' | 'other';
  startTime: string;
  endTime?: string;
  allDay?: boolean;
  timezone?: string;
  location?: string;
  isVirtual?: boolean;
  meetingUrl?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  color?: string;
  recurrenceRule?: string;
  recurrenceId?: string;
  attendees?: CalendarEventAttendee[];
  reminders?: { type: 'email' | 'notification'; minutes: number }[];
  notes?: string;
  tags?: string[];
}

export type UpdateEventInput = Omit<Partial<CreateEventInput>, 'calendarId' | 'recurrenceId'>;

export interface ListEventsParams {
  limit?: number;
  cursor?: string;
  search?: string;
  type?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  calendarIds?: string;
}

export interface RangeEventsParams {
  startDate: string;
  endDate: string;
  calendarIds?: string;
}

export interface WeeklyAvailability {
  monday: { start: string; end: string }[];
  tuesday: { start: string; end: string }[];
  wednesday: { start: string; end: string }[];
  thursday: { start: string; end: string }[];
  friday: { start: string; end: string }[];
  saturday: { start: string; end: string }[];
  sunday: { start: string; end: string }[];
}

export interface BookingQuestion {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select';
  required: boolean;
  options?: string[];
}

export interface BookingPage {
  id: string;
  personalAccountId?: string;
  name: string;
  slug: string;
  description?: string | null;
  ownerId: string;
  duration: number;
  bufferBefore?: number | null;
  bufferAfter?: number | null;
  color?: string | null;
  isActive?: boolean | null;
  locationType?: string | null;
  locationValue?: string | null;
  availability: WeeklyAvailability;
  questions?: BookingQuestion[] | null;
  minNotice?: number | null;
  maxAdvance?: number | null;
  confirmationMessage?: string | null;
  timezone: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CreateBookingPageInput {
  name: string;
  slug: string;
  description?: string;
  duration: number;
  bufferBefore?: number;
  bufferAfter?: number;
  color?: string;
  isActive?: boolean;
  locationType?: 'in-person' | 'phone' | 'video';
  locationValue?: string;
  availability: WeeklyAvailability;
  questions?: BookingQuestion[];
  minNotice?: number;
  maxAdvance?: number;
  confirmationMessage?: string;
  timezone?: string;
}

export type UpdateBookingPageInput = Partial<CreateBookingPageInput>;

export interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface CalendarBooking {
  id: string;
  personalAccountId?: string;
  bookingPageId: string;
  calendarEventId?: string | null;
  bookerName: string;
  bookerEmail: string;
  startTime: string | Date;
  endTime: string | Date;
  status: string;
  answers?: Record<string, unknown> | null;
  notes?: string | null;
  guests?: { email: string; name?: string }[] | null;
  timezone?: string | null;
  cancelledAt?: string | Date | null;
  cancelReason?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface WeldmailDomain {
  domain: string;
}

export type WeldmailCheckResult =
  | { available: true; email: string; domain: string }
  | { available: false; reason: 'reserved' | 'taken' };

export interface WeldmailReserveResult {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  isDefault: boolean;
}

export interface SendMessageBody {
  accountId: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  /** RFC 5322 Message-ID being answered. */
  inReplyTo?: string;
  /** Ancestry chain; the first entry roots the thread. */
  references?: string[];
  threadId?: string;
  idempotencyKey?: string;
}

export interface ReplyMessageBody {
  textBody?: string;
  htmlBody?: string;
  /** Keep the original To/Cc participants on the reply. */
  replyAll?: boolean;
  idempotencyKey?: string;
}

export interface ForwardMessageBody {
  to: string | string[];
  cc?: string | string[];
  textBody?: string;
  htmlBody?: string;
  idempotencyKey?: string;
}

export interface ListMessagesParams {
  accountId?: string;
  label?: string;
  /** Return one conversation, oldest message first. */
  threadId?: string;
  unreadOnly?: boolean;
  cursor?: string;
  limit?: number;
}

export interface RegisterPushTokenBody {
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId: string;
  tokenType?: 'expo' | 'fcm' | 'apns';
  /** Defaults to 'weldmail' server-side. */
  appCode?: string;
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
}

export interface PushTokenResult {
  deviceId: string;
  platform?: string;
  registered?: boolean;
  unregistered?: boolean;
}

export interface PatchMessageBody {
  isRead?: boolean;
  isStarred?: boolean;
  isTrash?: boolean;
  labels?: string[];
}

export interface CreateDraftBody {
  accountId: string;
  subject?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  body?: string;
  htmlBody?: string;
  importance?: 'low' | 'normal' | 'high';
  labels?: string[];
  attachmentIds?: string[];
  inReplyTo?: string;
  originalMessageId?: string;
  isReply?: boolean;
  isForward?: boolean;
}

export type UpdateDraftBody = Omit<CreateDraftBody, 'accountId'>;
