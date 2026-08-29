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
  labels?: string[] | null;
  sendStatus?: string | null;
  source?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
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
  entitlements?: {
    plan: 'free' | 'pro';
    maxAddresses: number;
    dailySendLimit: number;
  };
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
  inReplyTo?: string;
  threadId?: string;
  idempotencyKey?: string;
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
