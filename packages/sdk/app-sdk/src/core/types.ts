/**
 * Shared types for the WeldSuite app bridge protocol.
 *
 * PROTOCOL SYNC WARNING: the message shapes below (`weldapp:ready`,
 * `weldapp:init`, `weldapp:request`, `weldapp:response`, `weldapp:event`,
 * `weldapp:notify`) are implemented by the platform host
 * (`apps/web/platform/app/weldapps/host/`) and the CLI local shell
 * (`packages/sdk/cli/src/local-shell/`). Any change here must be mirrored on
 * both host sides and vice versa.
 */

/** Theme values delivered by the WeldSuite host. */
export type WeldTheme = 'light' | 'dark';

/**
 * Locale code delivered by the host. `en` and `nl` today; open-ended so a new
 * platform locale doesn't break apps built against this version.
 */
export type WeldLocale = 'en' | 'nl' | (string & {});

/** The workspace member currently viewing the app. */
export interface WeldAppUser {
  id: string;
  name: string;
  imageUrl?: string;
}

/**
 * Token bundle returned by the host on a legacy `getToken` request.
 * `tokenExpiresAt` is an ISO-8601 timestamp; epoch milliseconds are also
 * accepted defensively.
 *
 * Protocol 2 hosts never put a token in the iframe: API requests are proxied
 * through the host (see {@link BridgeFetchRequest}).
 */
export interface WeldTokenInfo {
  token: string;
  tokenExpiresAt: string | number;
  apiBaseUrl: string;
}

/** Where this app instance is rendered by the host. */
export type WeldSurface = 'page' | 'modal';

/**
 * Platform design tokens pushed by the host so apps render with the exact
 * suite palette, radius and font instead of a copied approximation.
 */
export interface WeldDesignTokens {
  /** Suite token values keyed by name without the `--wui-` prefix (`primary`, `radius`, …). */
  vars: Record<string, string>;
  /** CSS `font-family` of the platform body text. */
  fontFamily?: string;
  /** Stylesheet URL that loads {@link fontFamily} (Google Fonts only). */
  fontStylesheet?: string;
}

/** Payload of the host's `weldapp:init` handshake reply. */
export interface InitPayload {
  appCode: string;
  theme: WeldTheme;
  locale: WeldLocale;
  apiBaseUrl: string;
  /**
   * Legacy (protocol 1) hosts put a workspace-scoped token here. Protocol 2
   * hosts send `null` and proxy API requests instead, so no credential ever
   * enters the sandbox.
   */
  token: string | null;
  tokenExpiresAt: string | number | null;
  user: WeldAppUser;
  /**
   * App-relative path from the platform URL (`/` or `/products`), derived from
   * `/apps/{code}{path}`. Apps use this (and `route` events) instead of building
   * their own sidebar.
   */
  path?: string;
  /**
   * Set by the CLI local shell (`weld app dev`) so the SDK keeps in-memory
   * app-storage while still using the real postMessage bridge for toast /
   * navigate / theme. Production platform hosts never set this.
   */
  localPreview?: boolean;
  /** Bridge protocol spoken by the host. Absent means 1 (token in init). */
  protocol?: number;
  /** Platform design tokens (protocol 2). Updated via `designTokens` events. */
  designTokens?: WeldDesignTokens;
  /** Where the host renders this instance. Absent means `page`. */
  surface?: WeldSurface;
  /** Set when {@link surface} is `modal`: what the opener passed to `openModal`. */
  modal?: { title?: string; params?: unknown };
}

/** Methods the app can invoke on the host. */
export type BridgeRequestMethod =
  | 'getToken'
  | 'navigate'
  | 'toast'
  | 'fetch'
  | 'setBreadcrumbs'
  | 'setDirty'
  | 'confirm'
  | 'openModal'
  | 'closeModal';

/** Push events apps can subscribe to with `bridge.on()`. */
export type BridgeEventName = 'theme' | 'locale' | 'route';

/** App → host: sent once on boot to start the handshake. */
export interface ReadyMessage {
  type: 'weldapp:ready';
}

/** Host → app: handshake reply carrying the full init payload. */
export interface InitMessage {
  type: 'weldapp:init';
  payload: InitPayload;
}

/** App → host: correlated request. */
export interface RequestMessage {
  type: 'weldapp:request';
  id: string;
  method: BridgeRequestMethod;
  payload?: unknown;
}

/** Host → app: correlated response. */
export interface ResponseMessage {
  type: 'weldapp:response';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message: string };
}

/** Host → app: push event (theme / locale / route / design tokens). */
export type EventMessage =
  | {
      type: 'weldapp:event';
      event: BridgeEventName;
      payload: { value: string };
    }
  | {
      type: 'weldapp:event';
      event: 'designTokens';
      payload: { value: WeldDesignTokens };
    };

/** Global shortcut the SDK hands to the host (e.g. Cmd/Ctrl+K). */
export interface ShortcutPayload {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** App → host: fire-and-forget notification (no response). */
export type NotifyMessage =
  | { type: 'weldapp:notify'; event: 'mounted' }
  | { type: 'weldapp:notify'; event: 'shortcut'; payload: ShortcutPayload };

export type HostMessage = InitMessage | ResponseMessage | EventMessage;
export type AppMessage = ReadyMessage | RequestMessage | NotifyMessage;

/**
 * `fetch` request payload: the host performs the call with the member's
 * platform session and returns the response. `path` is relative to the API
 * the app targets (`/v1/...` for community apps).
 */
export interface BridgeFetchRequest {
  method: string;
  path: string;
  headers: [string, string][];
  body: string | ArrayBuffer | null;
}

/** `fetch` response payload. */
export interface BridgeFetchResponse {
  status: number;
  statusText?: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

/** One app-level breadcrumb; `path` is app-relative (`/orders/42`). */
export interface WeldBreadcrumb {
  label: string;
  path?: string;
}

/** Options for a host-rendered confirmation dialog. */
export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  destructive?: boolean;
}

/** Options for a host-rendered modal showing another route of this app. */
export interface OpenModalOptions {
  /** App-relative route rendered inside the modal. */
  path: string;
  title?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Structured-cloneable data handed to the modal instance as `init.modal.params`. */
  params?: unknown;
}

/** How a modal opened with `openModal` ended. */
export interface ModalResult<T = unknown> {
  /** True when the user closed it (Escape, backdrop, close button). */
  dismissed: boolean;
  /** Value the modal passed to `closeModal(result)`. */
  result?: T;
}

/** Toast variants supported by the host shell. */
export type ToastVariant = 'default' | 'success' | 'error' | 'warning';

// ---------------------------------------------------------------------------
// external-api response envelopes
// ---------------------------------------------------------------------------

/** `{ data: T }` — single-resource envelope. */
export interface SingleResponse<T> {
  data: T;
}

export interface ListPagination {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

/** `{ data: T[], pagination }` — list envelope with cursor pagination. */
export interface ListResponse<T> {
  data: T[];
  pagination: ListPagination;
}

/** A stored app-storage record. The document itself lives under `data`. */
export interface AppRecord<T = Record<string, unknown>> {
  id: string;
  data: T;
  createdAt?: string;
  updatedAt?: string;
}

/** Options for listing app-storage records. */
export interface RecordListOptions {
  limit?: number;
  cursor?: string;
  /** jsonb containment filter, e.g. `{ status: 'open' }`. Serialized as a JSON query param. */
  filter?: Record<string, unknown>;
}

/** Typed accessor for one app-storage collection. */
export interface RecordsClient<T extends Record<string, unknown> = Record<string, unknown>> {
  list(options?: RecordListOptions): Promise<ListResponse<AppRecord<T>>>;
  create(data: T): Promise<AppRecord<T>>;
  get(id: string): Promise<AppRecord<T>>;
  /** PATCH semantics on the API replace the whole document with `data`. */
  update(id: string, data: T): Promise<AppRecord<T>>;
  remove(id: string): Promise<void>;
}

/** Key-value store accessor. */
export interface KvClient {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Subset of a `/v1/people` row the scaffolded apps typically display. */
export interface PersonSummary {
  id: string;
  displayName?: string | null;
  fullName?: string | null;
  email?: string | null;
}

/** Subset of a `/v1/tickets` row. */
export interface TicketSummary {
  id: string;
  subject?: string | null;
  status?: string | null;
}

export interface ResourceListOptions {
  limit?: number;
  cursor?: string;
  search?: string;
}

export interface PeopleClient {
  list(options?: ResourceListOptions): Promise<ListResponse<PersonSummary>>;
  get(id: string): Promise<SingleResponse<PersonSummary>>;
}

export interface TicketsClient {
  list(options?: ResourceListOptions): Promise<ListResponse<TicketSummary>>;
  get(id: string): Promise<SingleResponse<TicketSummary>>;
}

// ── WeldMail ──────────────────────────────────────────────────────────────────
// An app token acts as the workspace, so these reach the workspace's SHARED
// mailboxes only; a private mailbox answers 404.

export interface MailAddress {
  email: string;
  name?: string;
}

/** A `/v1/mail-accounts` row. Never carries credentials. */
export interface MailAccountSummary {
  id: string;
  name: string;
  email: string;
  displayName?: string | null;
  provider: string;
  status: string;
  isShared?: boolean | null;
  /** Whether sending is allowed (the address is on a verified WeldMail domain). */
  canSendViaApi: boolean;
}

/** A `/v1/mail-messages` list row (headers only; `get` adds the bodies). */
export interface MailMessageSummary {
  id: string;
  accountId: string;
  threadId?: string | null;
  from: MailAddress;
  to: MailAddress[];
  subject?: string | null;
  preview?: string | null;
  sentDate?: string | null;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  labels?: string[] | null;
}

export interface MailMessage extends MailMessageSummary {
  textBody?: string | null;
  htmlBody?: string | null;
  cc?: MailAddress[] | null;
  attachments: { id: string; fileName: string; contentType?: string | null; size: number }[];
}

/** A conversation; pass `threadId` + `accountId` to `threads.get`. */
export interface MailThreadSummary {
  threadId: string;
  accountId: string;
  subject: string;
  participants: string[];
  latestDate: string | null;
  preview: string;
  messageCount: number;
  unreadCount: number;
  labels: string[];
}

export interface MailDraftInput {
  accountId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  /** Upload ids from `POST /v1/mail-attachments`. */
  attachmentIds?: string[];
  inReplyTo?: string;
}

export interface MailDraft extends Omit<MailDraftInput, 'accountId'> {
  id: string;
  accountId: string;
  updatedAt: string;
}

export interface MailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  /** A body or an htmlBody is required. */
  body?: string;
  htmlBody?: string;
  attachmentIds?: string[];
}

export interface MailSendResult {
  messageId: string;
  accountId: string;
  subject: string;
  /** True when the Idempotency-Key matched an earlier send: nothing was sent again. */
  replayed: boolean;
}

export interface MailMessageListOptions extends ResourceListOptions {
  accountId?: string;
  label?: string;
  threadId?: string;
  isRead?: boolean;
}

export interface MailThreadListOptions extends ResourceListOptions {
  accountId?: string;
  /** `inbox` (default), `sent`, `starred`, `archive`, `trash`, `spam`, `all`, or a label name. */
  label?: string;
}

export interface MailClient {
  accounts: {
    list(options?: ResourceListOptions): Promise<ListResponse<MailAccountSummary>>;
    get(id: string): Promise<SingleResponse<MailAccountSummary>>;
  };
  messages: {
    list(options?: MailMessageListOptions): Promise<ListResponse<MailMessageSummary>>;
    get(id: string): Promise<SingleResponse<MailMessage>>;
    /** Requires `mail_messages:write`. */
    update(
      id: string,
      flags: { isRead?: boolean; isStarred?: boolean; isFlagged?: boolean; isImportant?: boolean },
    ): Promise<SingleResponse<MailMessage>>;
    /** Requires `mail_messages:write`. */
    move(id: string, location: 'inbox' | 'archive' | 'trash' | 'spam'): Promise<void>;
  };
  threads: {
    list(options?: MailThreadListOptions): Promise<ListResponse<MailThreadSummary>>;
    get(threadId: string, accountId: string): Promise<SingleResponse<{ threadId: string; messages: MailMessage[] }>>;
  };
  drafts: {
    list(options?: ResourceListOptions & { accountId?: string }): Promise<ListResponse<MailDraft>>;
    /** Requires `mail_drafts:write`. */
    create(input: MailDraftInput): Promise<MailDraft>;
    /** Requires `mail_drafts:write`. */
    update(id: string, input: Partial<MailDraftInput>): Promise<MailDraft>;
    /** Requires `mail_drafts:write`. */
    remove(id: string): Promise<void>;
  };
  /**
   * Sending — each requires `mail_messages:send`, which must be requested by
   * name. `idempotencyKey` makes a retry safe.
   */
  send(accountId: string, input: MailSendInput, idempotencyKey?: string): Promise<MailSendResult>;
  reply(
    messageId: string,
    input: { body?: string; htmlBody?: string; replyAll?: boolean; attachmentIds?: string[] },
    idempotencyKey?: string,
  ): Promise<MailSendResult>;
  sendDraft(draftId: string, idempotencyKey?: string): Promise<MailSendResult>;
}

// ── WeldReach ─────────────────────────────────────────────────────────────────
// Cold email outreach, on request only: until WeldSuite approves the workspace
// every `/v1/reach` call answers 403 `APP_ACCESS_REQUIRED` with
// `details: { appCode, status }`. Mirrors `@weldsuite/app-api-client/schemas/reach`
// (kept as plain types here: this package is published on its own).

export type ReachCampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export type ReachEnrollmentStatus =
  | 'queued'
  | 'active'
  | 'replied'
  | 'bounced'
  | 'unsubscribed'
  | 'completed'
  | 'paused'
  | 'failed';
export type ReachProspectValidation = 'valid' | 'role' | 'consumer' | 'no_mx' | 'invalid' | 'suppressed';
export type ReachReplyLabel =
  | 'interested'
  | 'meeting_request'
  | 'not_interested'
  | 'not_now'
  | 'out_of_office'
  | 'wrong_person'
  | 'unsubscribe'
  | 'other'
  | 'unclassified';
export type ReachInboundKind = 'reply' | 'auto_reply' | 'bounce';
export type ReachMailboxStatus =
  | 'provisioning'
  | 'warming'
  | 'active'
  | 'paused'
  | 'suspended'
  | 'error'
  | 'deleting'
  | 'deleted';
export type ReachWarmupBlocker = 'too_early' | 'not_enough_data' | 'low_inbox_rate' | 'login_error' | 'pool_too_small';

/** `GET /v1/reach/access`: staff-set limits, today's usage and the global send switch. */
export interface ReachAccess {
  status: 'approved';
  limits: {
    maxDomains: number;
    maxMailboxes: number;
    maxDailySends: number;
    allowConsumerRecipients: boolean;
    forceAllowDomains: string[];
  };
  usage: { domains: number; mailboxes: number; sendsToday: number };
  sendingEnabled: boolean;
}

/** `GET /v1/reach/overview`: the dashboard numbers. Rates are 0..1. */
export interface ReachOverview {
  sentToday: number;
  sent7d: number;
  replies7d: number;
  interested7d: number;
  bounceRate7d: number;
  replyRate7d: number;
  activeCampaigns: number;
  mailboxes: { active: number; warming: number; paused: number; error: number };
  unreadReplies: number;
  daily: Array<{ date: string; sent: number; replies: number }>;
}

export interface ReachCampaignStats {
  prospects: number;
  sent: number;
  replied: number;
  interested: number;
  bounced: number;
  unsubscribed: number;
}

/** Schedule fields of a campaign. `sendDays` are ISO weekdays, 1 (Mon) to 7 (Sun); windows are `HH:MM`. */
export interface ReachCampaignSchedule {
  timezone: string;
  sendDays: number[];
  windowStart: string;
  windowEnd: string;
  dailyLimit: number;
  minGapMinutes: number;
  stopOnAutoReply: boolean;
}

export interface ReachCampaign extends ReachCampaignSchedule {
  id: string;
  name: string;
  status: ReachCampaignStatus;
  stats: ReachCampaignStats;
  pausedReason: string | null;
  launchedAt: string | null;
  completedAt: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One email of a sequence. Subject and body support `{{variable}}` / `{{variable|fallback}}`. */
export interface ReachStepInput {
  /** Wait after the previous step, 0..90 days (not used for the first step). */
  delayDays: number;
  /** 0..23 extra hours. */
  delayHours: number;
  subject: string;
  body: string;
  /** Send as a reply in the same thread instead of a new email. */
  replyInThread: boolean;
}

export interface ReachCampaignStep extends ReachStepInput {
  id: string;
  order: number;
}

export interface ReachCampaignDetail extends ReachCampaign {
  steps: ReachCampaignStep[];
  mailboxIds: string[];
}

export type ReachCampaignCreateInput = Partial<ReachCampaignSchedule> & { name: string };
export type ReachCampaignUpdateInput = Partial<ReachCampaignSchedule> & { name?: string; ownerId?: string | null };

/** Enroll by prospect ids, a list, or both. */
export interface ReachEnrollInput {
  prospectIds?: string[];
  listId?: string;
}

export interface ReachEnrollReport {
  added: number;
  skipped: Array<{
    reason: 'already_enrolled' | 'suppressed' | 'consumer' | 'invalid' | 'enrolled_elsewhere';
    count: number;
  }>;
}

export interface ReachEnrollment {
  id: string;
  campaignId: string;
  prospect: Pick<ReachProspect, 'id' | 'email' | 'firstName' | 'lastName' | 'companyName'>;
  mailboxId: string | null;
  mailboxEmail: string | null;
  status: ReachEnrollmentStatus;
  /** `order` of the step sent next. */
  currentStep: number;
  nextSendAt: string | null;
  stoppedReason: string | null;
  updatedAt: string;
}

export interface ReachCampaignStepStats {
  stepId: string;
  order: number;
  sent: number;
  replied: number;
  bounced: number;
}

export interface ReachCampaignListOptions extends ResourceListOptions {
  status?: ReachCampaignStatus;
}

export interface ReachEnrollmentListOptions {
  limit?: number;
  cursor?: string;
  status?: ReachEnrollmentStatus;
}

export interface ReachProspect {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  companyDomain: string | null;
  title: string | null;
  timezone: string | null;
  customFields: Record<string, string>;
  source: 'csv' | 'crm_list' | 'welddata' | 'manual';
  sourceRef: string | null;
  personId: string | null;
  validation: ReachProspectValidation;
  createdAt: string;
}

export interface ReachProspectInput {
  email: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  title?: string;
  timezone?: string;
  /** Up to 50 string fields; each key is also a template variable. */
  customFields?: Record<string, string>;
}

export type ReachProspectUpdateInput = Partial<Omit<ReachProspectInput, 'email'>>;

export interface ReachImportInput {
  /** 1 to `REACH_IMPORT_MAX_ROWS` (5,000) rows. */
  rows: ReachProspectInput[];
  /** Add to an existing list ... */
  listId?: string;
  /** ... or create one with this name. */
  listName?: string;
  sourceRef?: string;
}

export interface ReachImportReport {
  listId: string | null;
  created: number;
  updated: number;
  /** Rows not usable, by reason; the stored ones keep their `validation`. */
  skipped: Array<{ reason: ReachProspectValidation | 'duplicate' | 'invalid_row'; count: number }>;
}

export interface ReachProspectListOptions extends ResourceListOptions {
  validation?: ReachProspectValidation;
  listId?: string;
}

export interface ReachProspectList {
  id: string;
  name: string;
  description: string | null;
  source: 'csv' | 'crm_list' | 'welddata' | 'manual';
  sourceRef: string | null;
  prospectCount: number;
  createdAt: string;
}

export interface ReachListInput {
  name: string;
  description?: string;
}

export interface ReachSuppression {
  id: string;
  value: string;
  type: 'email' | 'domain';
  reason: 'unsubscribed' | 'bounced' | 'complained' | 'manual' | 'negative_reply';
  source: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ReachMessage {
  id: string;
  direction: 'out' | 'in';
  campaignId: string | null;
  stepId: string | null;
  mailboxId: string;
  prospectId: string | null;
  threadKey: string | null;
  fromEmail: string;
  toEmail: string;
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  status: 'sending' | 'sent' | 'failed' | 'unknown' | null;
  kind: ReachInboundKind | null;
  label: ReachReplyLabel | null;
  labelSource: 'ai' | 'user' | 'rule' | null;
  readAt: string | null;
  handledAt: string | null;
  sentAt: string | null;
  receivedAt: string | null;
}

export interface ReachThreadSummary {
  /** The thread's id: the Message-ID of its first email. */
  threadKey: string;
  prospect: Pick<ReachProspect, 'id' | 'email' | 'firstName' | 'lastName' | 'companyName' | 'personId'> | null;
  campaign: { id: string; name: string } | null;
  mailbox: { id: string; email: string };
  lastInbound: Pick<
    ReachMessage,
    'id' | 'subject' | 'snippet' | 'kind' | 'label' | 'labelSource' | 'receivedAt' | 'readAt' | 'handledAt'
  >;
  messageCount: number;
}

export interface ReachThread {
  threadKey: string;
  summary: ReachThreadSummary;
  messages: ReachMessage[];
}

export interface ReachThreadListOptions {
  limit?: number;
  cursor?: string;
  /** `open` (default), `unread`, `handled` or `all`. */
  state?: 'open' | 'unread' | 'handled' | 'all';
  label?: ReachReplyLabel;
  kind?: ReachInboundKind;
  campaignId?: string;
  mailboxId?: string;
}

/** The thread list, with the inbox-wide unread count. */
export interface ReachThreadListResponse extends ListResponse<ReachThreadSummary> {
  meta: { unreadCount: number };
}

export interface ReachMailbox {
  id: string;
  domainId: string;
  domainName: string;
  email: string;
  firstName: string;
  lastName: string;
  signature: string | null;
  type: 'google' | 'shared';
  status: ReachMailboxStatus;
  warmupDay: number;
  warmupStatus: string | null;
  /** Inbox placement of its warmup mail over 3 days (0..1); null below the minimum sample. */
  warmupInboxRate: number | null;
  warmupSent7d: number;
  warmupSpamRescues7d: number;
  /** Why a warming mailbox may not join campaigns yet; null when ready or not warming. */
  warmupBlocker: ReachWarmupBlocker | null;
  dailyCap: number;
  rampCurrent: number;
  sentToday: number;
  lastSentAt: string | null;
  pausedReason: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ReachDomain {
  id: string;
  hostDomainId: string;
  name: string;
  mailpoolDomainId: string | null;
  status: 'connecting' | 'active' | 'error' | 'disconnecting';
  dnsStatus: { spf: boolean; dkim: boolean; dmarc: boolean; mx: boolean; checkedAt: string } | null;
  dmarcPolicy: string | null;
  connectedAt: string | null;
  lastError: string | null;
  mailboxCount: number;
  createdAt: string;
}

export interface ReachClient {
  /** Requires `reach_campaigns:read`. */
  access(): Promise<SingleResponse<ReachAccess>>;
  /** Requires `reach_campaigns:read`. */
  overview(): Promise<SingleResponse<ReachOverview>>;
  /** Reads require `reach_campaigns:read`; every other method `reach_campaigns:write`. */
  campaigns: {
    list(options?: ReachCampaignListOptions): Promise<ListResponse<ReachCampaign>>;
    get(id: string): Promise<SingleResponse<ReachCampaignDetail>>;
    create(input: ReachCampaignCreateInput): Promise<ReachCampaignDetail>;
    update(id: string, input: ReachCampaignUpdateInput): Promise<ReachCampaignDetail>;
    /** A running campaign must be paused first (409 `CAMPAIGN_ACTIVE`). */
    remove(id: string): Promise<void>;
    /** Replaces the whole sequence (1..10 steps). */
    setSteps(id: string, steps: ReachStepInput[]): Promise<ReachCampaignDetail>;
    /** Replaces the sending mailboxes. */
    setMailboxes(id: string, mailboxIds: string[]): Promise<ReachCampaignDetail>;
    enroll(id: string, input: ReachEnrollInput): Promise<ReachEnrollReport>;
    enrollments(id: string, options?: ReachEnrollmentListOptions): Promise<ListResponse<ReachEnrollment>>;
    removeEnrollment(id: string, enrollmentId: string): Promise<void>;
    /** 400 with `details.problems` when the campaign is not ready. */
    launch(id: string): Promise<ReachCampaignDetail>;
    pause(id: string): Promise<ReachCampaignDetail>;
    resume(id: string): Promise<ReachCampaignDetail>;
    stats(id: string): Promise<ReachCampaignStepStats[]>;
  };
  /** Reads require `reach_prospects:read`; writes `reach_prospects:write`. */
  prospects: {
    list(options?: ReachProspectListOptions): Promise<ListResponse<ReachProspect>>;
    get(id: string): Promise<SingleResponse<ReachProspect>>;
    create(input: ReachProspectInput & { listId?: string }): Promise<ReachProspect>;
    /** Up to REACH_IMPORT_MAX_ROWS rows per call; existing addresses are updated. */
    import(input: ReachImportInput): Promise<ReachImportReport>;
    update(id: string, input: ReachProspectUpdateInput): Promise<ReachProspect>;
    remove(id: string): Promise<void>;
  };
  /** Reads require `reach_prospects:read`; writes `reach_prospects:write`. */
  lists: {
    list(options?: { limit?: number; cursor?: string }): Promise<ListResponse<ReachProspectList>>;
    get(id: string): Promise<SingleResponse<ReachProspectList>>;
    create(input: ReachListInput): Promise<ReachProspectList>;
    update(id: string, input: Partial<ReachListInput>): Promise<ReachProspectList>;
    remove(id: string): Promise<void>;
    addMembers(id: string, prospectIds: string[]): Promise<{ added: number }>;
    removeMembers(id: string, prospectIds: string[]): Promise<{ removed: number }>;
  };
  /** The suppression list. Reads require `reach_settings:read`; writes `reach_settings:write`. */
  suppressions: {
    list(options?: ResourceListOptions): Promise<ListResponse<ReachSuppression>>;
    /** Addresses or domains; `skipped` counts malformed values and ones already listed. */
    add(values: string[]): Promise<{ added: number; skipped: number }>;
    remove(id: string): Promise<void>;
  };
  /** The reply inbox. Requires `reach_inbox:read`. */
  threads: {
    list(options?: ReachThreadListOptions): Promise<ReachThreadListResponse>;
    get(threadKey: string): Promise<SingleResponse<ReachThread>>;
    /**
     * Answer the thread's latest reply from the mailbox that received it.
     * Requires `reach_inbox:reply`, which must be requested by name; a
     * wildcard does not include it.
     */
    reply(threadKey: string, body: string): Promise<ReachMessage>;
  };
  /** Read-only (each inbox is billed, so they are created in the app). Requires `reach_mailboxes:read`. */
  mailboxes: {
    list(options?: { domainId?: string; status?: ReachMailboxStatus }): Promise<ListResponse<ReachMailbox>>;
    get(id: string): Promise<SingleResponse<ReachMailbox>>;
  };
  /** Read-only. Requires `reach_mailboxes:read`. */
  domains: {
    list(): Promise<ListResponse<ReachDomain>>;
    get(id: string): Promise<SingleResponse<ReachDomain>>;
  };
}

/** Subset of a `/v1/products` row used by commerce WeldApps. */
export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  sku?: string | null;
  status?: string | null;
  price?: string | number | null;
  currency?: string | null;
  imageUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Create body for `/v1/products` (name + slug required). */
export interface CreateProductInput {
  name: string;
  slug: string;
  description?: string;
  sku?: string;
  status?: string;
  price?: string | number;
  currency?: string;
  imageUrl?: string;
  [key: string]: unknown;
}

export type UpdateProductInput = Partial<CreateProductInput>;

export interface ProductListOptions extends ResourceListOptions {
  /** Filter by product status (e.g. `active`, `draft`). */
  status?: string;
}

export interface ProductsClient {
  list(options?: ProductListOptions): Promise<ListResponse<ProductSummary>>;
  get(id: string): Promise<SingleResponse<ProductSummary>>;
  create(input: CreateProductInput): Promise<ProductSummary>;
  update(id: string, input: UpdateProductInput): Promise<ProductSummary>;
  remove(id: string): Promise<void>;
}
