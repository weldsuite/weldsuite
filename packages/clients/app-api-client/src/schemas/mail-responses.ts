/**
 * Response shapes of mail-api (WeldMail): accounts, messages, threads,
 * labels, folders, drafts, attachments, signatures, templates, rules,
 * campaigns, sync, snooze, scheduled sends, subscriptions and the
 * cross-workspace mailbox directory.
 *
 * The platform and the mobile apps read these through the TypeScript
 * interfaces in `../domains/mail-*.ts`; these Zod schemas mirror them so the
 * Rust backend's answers are checked against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas.ts`). Rows are
 * `.passthrough()`: the routes answer whole table rows, and the schemas pin
 * the fields the clients read.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const nullableBoolean = z.boolean().nullable();
const nullableStrings = z.array(z.string()).nullable();
const nullableRecord = z.record(z.unknown()).nullable();

/** `createdAt` / `updatedAt` / `deletedAt`, as every row carries them. */
const timestamps = {
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: nullableString,
};

/** `{ id }`: what an update answers, with the fields it changed. */
export const mailIdResultSchema = z.object({ id: z.string() }).passthrough();

// ── accounts ────────────────────────────────────────────────────────────────

export const mailAccountRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    displayName: nullableString,
    provider: z.string(),
    authType: nullableString,
    status: z.string(),
    isDefault: z.boolean(),
    isShared: z.boolean(),
    assignedUserIds: nullableStrings,
    syncEnabled: z.boolean(),
    syncFrequency: nullableNumber,
    syncStatus: nullableString,
    lastSyncAt: nullableString,
    sentToday: z.number(),
    dailySendLimit: z.number(),
    imapHost: nullableString,
    imapPort: nullableNumber,
    imapSecure: nullableBoolean,
    smtpHost: nullableString,
    smtpPort: nullableNumber,
    smtpSecure: nullableBoolean,
    signature: nullableString,
    aiSettings: nullableRecord,
    /** Left out of the answer: it can carry the provider's credentials. */
    providerConfig: nullableRecord.optional(),
    ...timestamps,
  })
  .passthrough();

export const mailAccountStatsSchema = z.object({
  total: z.number(),
  active: z.number(),
  inactive: z.number(),
  error: z.number(),
});

export const mailAccountLabelOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    color: nullableString.optional(),
  })
  .passthrough();

export const mailAccountCreatedSchema = z
  .object({ id: z.string(), name: z.string(), email: z.string() })
  .passthrough();

export const mailAccountAssignedSchema = z
  .object({ id: z.string(), isShared: z.boolean(), assignedUserIds: z.array(z.string()) })
  .passthrough();

export const mailAccountSyncTriggeredSchema = z.object({ id: z.string(), syncStatus: z.string() }).passthrough();

// ── messages ────────────────────────────────────────────────────────────────

export const mailAddressSchema = z
  .object({
    email: z.string(),
    name: nullableString.optional(),
    avatarUrl: nullableString.optional(),
  })
  .passthrough();

const mailMessageFields = {
  id: z.string(),
  accountId: z.string(),
  messageId: z.string(),
  threadId: nullableString,
  from: mailAddressSchema.nullable(),
  to: z.array(mailAddressSchema).nullable(),
  cc: z.array(mailAddressSchema).nullable(),
  bcc: z.array(mailAddressSchema).nullable(),
  replyTo: mailAddressSchema.nullable(),
  subject: nullableString,
  preview: nullableString,
  sentDate: nullableString,
  receivedDate: nullableString,
  isRead: z.boolean(),
  isStarred: z.boolean(),
  isFlagged: z.boolean(),
  isImportant: z.boolean(),
  isDraft: z.boolean(),
  isReply: z.boolean(),
  hasAttachments: z.boolean(),
  attachmentCount: z.number(),
  priority: nullableString,
  labels: nullableStrings,
  sizeBytes: nullableNumber,
  scheduledFor: nullableString,
  sendStatus: nullableString,
  snoozedUntil: nullableString.optional(),
  source: nullableString,
  inReplyTo: nullableString,
  references: nullableStrings,
  externalMessageId: nullableString,
  ...timestamps,
};

export const mailMessageRowSchema = z
  .object({ ...mailMessageFields, textBody: nullableString, htmlBody: nullableString })
  .passthrough();

/**
 * A row of `GET /api/mail-messages`: the list's projection leaves out the
 * bodies and the reply bookkeeping (`listMessagesWide`), which
 * `MailMessageRow` declares; opening the message loads them.
 */
export const mailMessageListRowSchema = z
  .object(mailMessageFields)
  .partial({
    bcc: true,
    replyTo: true,
    isReply: true,
    source: true,
    inReplyTo: true,
    references: true,
    externalMessageId: true,
    updatedAt: true,
    deletedAt: true,
  })
  .passthrough();

/** A message as a thread-list row carries it: no bodies. */
export const mailThreadListMessageSchema = z.object(mailMessageFields).passthrough();

export const mailMessageWithAttachmentsSchema = mailMessageRowSchema.extend({
  attachments: z.array(
    z
      .object({
        id: z.string(),
        fileName: z.string(),
        contentType: nullableString,
        size: z.number(),
        isInline: nullableBoolean,
      })
      .passthrough(),
  ),
});

export const mailMessageStatsSchema = z.object({
  total: z.number(),
  unread: z.number(),
  inboxUnread: z.number(),
  starred: z.number(),
  importantUnread: z.number(),
  sentUnread: z.number(),
  archiveUnread: z.number(),
  trashUnread: z.number(),
  spam: z.number(),
  snoozed: z.number(),
  scheduled: z.number(),
  drafts: z.number(),
});

export const mailThreadSchema = z.object({
  threadId: z.string(),
  messages: z.array(mailMessageRowSchema),
});

export const mailBulkResultSchema = z.object({ affected: z.number() });

export const mailMessageLabelsResultSchema = z.object({ id: z.string(), labels: z.array(z.string()) });

export const forwardMailResponseSchema = z.object({
  messageId: z.string(),
  smtpMessageId: z.string(),
  pendingVerification: z.boolean(),
  forwardedFrom: z.string(),
});

// ── threads and labels ──────────────────────────────────────────────────────

export const mailThreadsReadSchema = z.object({ updatedCount: z.number() });

export const mailLabelRowSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    name: z.string(),
    color: nullableString,
    isSystem: nullableBoolean,
    slug: nullableString,
    messageCount: z.number(),
    position: nullableNumber,
    aiEnabled: nullableBoolean,
    aiKeywords: nullableStrings,
    aiDescription: nullableString,
    aiConfidence: nullableNumber,
    ...timestamps,
  })
  .passthrough();

export const mailLabelDeletedSchema = z.object({ id: z.string(), deleted: z.literal(true) });

export const mailLabelCountSchema = z.object({ count: z.number() });

export const mailLabelThreadAppliedSchema = z.object({
  affected: z.number(),
  action: z.enum(['add', 'remove']),
});

export const mailThreadSummarySchema = z
  .object({
    threadId: z.string(),
    accountId: z.string(),
    subject: z.string(),
    participants: z.array(z.string()),
    latestMessageId: z.string(),
    latestSender: z.string(),
    latestSenderEmail: z.string(),
    latestSenderAvatarUrl: nullableString,
    latestDate: nullableString,
    preview: z.string(),
    messageCount: z.number(),
    unreadCount: z.number(),
    hasAttachments: z.boolean(),
    isStarred: z.boolean(),
    labels: z.array(z.string()),
    scheduledFor: nullableString,
    sendStatus: nullableString,
    messages: z.array(mailThreadListMessageSchema),
  })
  .passthrough();

export const mailLabelThreadsSchema = z.object({
  threads: z.array(mailThreadSummarySchema),
  totalCount: z.number(),
  nextCursor: nullableString,
});

// ── folders, drafts, attachments, signatures ────────────────────────────────

export const mailFolderRowSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    name: z.string(),
    type: z.string(),
    parentId: nullableString,
    path: nullableString,
    totalCount: z.number(),
    unreadCount: z.number(),
    unseenCount: nullableNumber,
    lastSyncAt: nullableString,
    syncStatus: nullableString,
    uidValidity: nullableNumber,
    uidNext: nullableNumber,
    isSelectable: z.boolean(),
    isSubscribed: nullableBoolean,
    color: nullableString,
    icon: nullableString,
    position: z.number(),
    isSystem: nullableBoolean,
    specialUse: nullableStrings,
    externalFolderId: nullableString,
    ...timestamps,
  })
  .passthrough();

export const mailDraftRowSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    subject: nullableString,
    to: nullableStrings,
    cc: nullableStrings,
    bcc: nullableStrings,
    replyTo: nullableStrings,
    body: nullableString,
    htmlBody: nullableString,
    importance: nullableString,
    labels: nullableStrings,
    hasAttachments: nullableBoolean,
    attachmentCount: nullableNumber,
    attachmentIds: nullableStrings,
    inReplyTo: nullableString,
    originalMessageId: nullableString,
    isReply: nullableBoolean,
    isForward: nullableBoolean,
    lastAutoSavedAt: nullableString,
    ...timestamps,
  })
  .passthrough();

export const mailAttachmentRowSchema = z
  .object({
    id: z.string(),
    messageId: z.string(),
    fileName: z.string(),
    contentType: nullableString,
    size: z.number(),
    isInline: nullableBoolean,
    contentId: nullableString,
    contentDisposition: nullableString,
    checksum: nullableString,
    externalAttachmentId: nullableString,
    ...timestamps,
  })
  .passthrough();

export const mailAttachmentsAssociatedSchema = z.object({ messageId: z.string(), associated: z.number() });

export const mailSignatureRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    content: z.string(),
    isDefault: z.boolean(),
    accountIds: nullableStrings,
    userIds: nullableStrings,
    type: z.enum(['personal', 'company', 'department']),
    includeInReplies: z.boolean(),
    includeInForwards: z.boolean(),
    position: z.enum(['above', 'below']),
    tags: nullableStrings,
    metadata: nullableRecord,
    ...timestamps,
  })
  .passthrough();

// ── templates, rules, campaigns ─────────────────────────────────────────────

export const mailTemplateRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    subject: z.string(),
    htmlContent: z.string(),
    textContent: nullableString,
    category: nullableString,
    description: nullableString,
    variables: z.array(z.record(z.unknown())).nullable(),
    requiredVariables: nullableStrings,
    type: z.string(),
    purpose: nullableString,
    usageCount: nullableNumber,
    lastUsedAt: nullableString,
    isActive: z.boolean(),
    isDefault: nullableBoolean,
    tags: nullableStrings,
    metadata: nullableRecord,
    ...timestamps,
  })
  .passthrough();

/** One of `GET /categories`: a category name. */
export const mailTemplateCategorySchema = z.string();

export const mailTemplateRenderSchema = z.object({
  subject: z.string(),
  htmlContent: z.string(),
  textContent: nullableString,
});

export const mailRuleRowSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    name: z.string(),
    description: nullableString,
    conditions: z.array(z.record(z.unknown())),
    matchType: z.string(),
    actions: z.array(z.record(z.unknown())),
    isActive: z.boolean(),
    stopProcessing: nullableBoolean,
    priority: nullableNumber,
    applyToExisting: nullableBoolean,
    appliedCount: nullableNumber,
    lastAppliedAt: nullableString,
    scope: nullableString,
    folders: nullableStrings,
    ...timestamps,
  })
  .passthrough();

export const mailRulesReorderedSchema = z.object({ updated: z.number() });

/** A Drizzle `numeric` rate column: a string, or a number. */
const rate = z.union([z.string(), z.number()]).nullable();

export const mailCampaignRowSchema = z
  .object({
    id: z.string(),
    templateId: nullableString,
    name: z.string(),
    subject: z.string(),
    preheader: nullableString,
    htmlContent: z.string(),
    textContent: nullableString,
    recipientList: z.record(z.unknown()),
    totalRecipients: z.number(),
    fromName: z.string(),
    fromEmail: z.string(),
    replyToEmail: nullableString,
    scheduledAt: nullableString,
    sentAt: nullableString,
    status: z.string(),
    sentCount: nullableNumber,
    deliveredCount: nullableNumber,
    bouncedCount: nullableNumber,
    openedCount: nullableNumber,
    clickedCount: nullableNumber,
    unsubscribedCount: nullableNumber,
    complaintCount: nullableNumber,
    deliveryRate: rate,
    openRate: rate,
    clickRate: rate,
    bounceRate: rate,
    unsubscribeRate: rate,
    isAbTest: nullableBoolean,
    trackOpens: z.boolean(),
    trackClicks: z.boolean(),
    tags: nullableStrings,
    ...timestamps,
  })
  .passthrough();

// ── sync, snooze, scheduled ─────────────────────────────────────────────────

export const mailSyncTriggerSchema = z
  .object({
    accountId: z.string(),
    status: z.literal('syncing'),
    syncedMessages: z.number(),
    label: z.string().optional(),
  })
  .passthrough();

export const mailSyncStatusSchema = z.object({ status: z.string(), lastSyncAt: nullableString });

export const mailSyncStatusUpdatedSchema = z.object({ id: z.string(), status: z.string() });

export const snoozedMessageSummarySchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    subject: nullableString,
    from: mailAddressSchema.nullable(),
    snoozedUntil: nullableString,
    snoozedAt: nullableString,
    triggerRunId: nullableString,
    createdAt: nullableString,
  })
  .passthrough();

export const mailSnoozeResultSchema = z.object({ id: z.string(), snoozedUntil: z.string() });

export const scheduleMailResultSchema = z.object({
  messageId: z.string(),
  smtpMessageId: z.string(),
  scheduledFor: z.string(),
  triggerRunId: z.string(),
});

export const rescheduleMailResultSchema = z.object({ scheduledFor: z.string(), triggerRunId: z.string() });

export const scheduledSentNowSchema = z.object({ id: z.string(), externalMessageId: z.string() });

// ── subscriptions ───────────────────────────────────────────────────────────

const unsubscribeMethod = z.enum(['one_click', 'mailto', 'link']);

export const mailSubscriptionRowSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    senderEmail: z.string(),
    senderName: nullableString,
    senderDomain: nullableString,
    listId: nullableString,
    unsubscribeUrl: nullableString,
    unsubscribeMailto: nullableString,
    oneClick: z.boolean(),
    messageCount: z.number(),
    lastSubject: nullableString,
    firstReceivedAt: z.string(),
    lastReceivedAt: z.string(),
    status: z.string(),
    unsubscribeMethod: unsubscribeMethod.nullable(),
    unsubscribedAt: nullableString,
    unsubscribedBy: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const mailSubscriptionsScannedSchema = z.object({ scanned: z.number(), subscriptions: z.number() });

export const mailUnsubscribeResultSchema = z.object({
  subscription: mailSubscriptionRowSchema,
  method: unsubscribeMethod,
  url: nullableString,
});

// ── mailbox directory ───────────────────────────────────────────────────────

export const workspaceMailboxGroupSchema = z.object({
  clerkOrgId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  slug: z.string(),
  imageUrl: nullableString,
  role: z.string(),
  accounts: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      displayName: z.string(),
      provider: nullableString,
      isDefault: z.boolean(),
      status: z.string(),
    }),
  ),
});
