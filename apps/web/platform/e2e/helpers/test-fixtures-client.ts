/**
 * Client for the app-api `/test-fixtures/*` router. Stamps the
 * X-Test-Token + X-Test-Workspace-Id headers on every request so specs
 * don't have to.
 *
 * Configured by env vars (set in `.env.test`):
 *   TEST_API_URL          — base URL of the running app-api (e.g.
 *                            http://localhost:8789 locally, or the test
 *                            env URL https://app-api-test.weldsuite.org).
 *   TEST_FIXTURES_TOKEN   — must match the worker secret.
 *   TEST_WORKSPACE_ID     — Clerk org id of the dedicated test workspace.
 *
 * `isTestFixturesConfigured()` returns false when any of the three env
 * vars are missing. Specs that depend on seeded data use it to skip
 * gracefully in environments where the infrastructure hasn't been set up
 * yet — keeps CI green during the rollout.
 */

export function isTestFixturesConfigured(): boolean {
  return Boolean(
    process.env.TEST_API_URL &&
      process.env.TEST_FIXTURES_TOKEN &&
      process.env.TEST_WORKSPACE_ID,
  );
}

const baseUrl = () => {
  const url = process.env.TEST_API_URL;
  if (!url) {
    throw new Error(
      'TEST_API_URL is not set. Add it to apps/web/platform/.env.test',
    );
  }
  return url.replace(/\/$/, '');
};

const token = () => {
  const t = process.env.TEST_FIXTURES_TOKEN;
  if (!t) {
    throw new Error(
      'TEST_FIXTURES_TOKEN is not set. Add it to apps/web/platform/.env.test',
    );
  }
  return t;
};

const workspaceId = () => {
  const id = process.env.TEST_WORKSPACE_ID;
  if (!id) {
    throw new Error(
      'TEST_WORKSPACE_ID is not set. Add it to apps/web/platform/.env.test',
    );
  }
  return id;
};

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${baseUrl()}/test-fixtures${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Test-Token': token(),
      'X-Test-Workspace-Id': workspaceId(),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as
    | { data?: T; error?: { code: string; message: string } };
  if (!res.ok) {
    const code = body.error?.code ?? `HTTP_${res.status}`;
    const message = body.error?.message ?? res.statusText;
    throw new Error(`test-fixtures ${path}: ${code} — ${message}`);
  }
  if (!body.data) {
    throw new Error(`test-fixtures ${path}: missing data envelope`);
  }
  return body.data;
}

export interface SeededCompany {
  id: string;
  displayName: string;
  name: string | null;
  tradingName: string | null;
}

export interface SeededPerson {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
}

export interface SeededPipeline {
  id: string;
  name: string;
}

export interface SeededLead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

export interface SeededList {
  id: string;
  name: string;
  kind: 'company' | 'person' | 'lead';
}

export interface SeededProject {
  id: string;
  name: string;
}

export interface SeededTask {
  id: string;
  title: string;
}

/** Input for {@link testFixtures.seedTask} — supports WeldFlow project placement. */
export interface SeedTaskInput {
  title?: string;
  projectId?: string;
  parentTaskId?: string;
  stageId?: string;
  status?: string;
}

// --- WeldChat ---------------------------------------------------------------

export interface SeededChatChannel {
  id: string;
  name: string;
  slug: string;
  type: 'public' | 'private' | 'dm' | 'entity';
  isDefault: boolean;
  voiceCallsEnabled: boolean;
  videoCallsEnabled: boolean;
}

export interface SeedChatChannelInput {
  name?: string;
  type?: 'public' | 'private' | 'dm' | 'entity';
  topic?: string;
  isDefault?: boolean;
  voiceCallsEnabled?: boolean;
  videoCallsEnabled?: boolean;
}

export interface SeededChatMessage {
  id: string;
  channelId: string;
  content: string;
  authorId: string;
  authorName: string;
}

export interface SeedChatMessageInput {
  channelId: string;
  content?: string;
  authorId?: string;
  authorName?: string;
  parentId?: string;
}

export interface SeededChatChannelMember {
  id: string;
  channelId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
}

export interface SeedChatChannelMemberInput {
  channelId: string;
  userId?: string;
  role?: 'owner' | 'admin' | 'member';
  memberType?: 'user' | 'agent';
}

export interface SeededOpportunity {
  id: string;
  name: string;
  status: string;
  stage: string;
  customerId: string;
}

export interface SeededActivity {
  id: string;
  type: string;
  subject: string;
  status: string;
  assignedToId: string;
}

export interface SeededSequence {
  id: string;
  name: string;
  status: string;
  description: string | null;
}

export interface SeededTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  priority: string;
  customerName: string;
  customerEmail: string;
}

export interface SeededMeeting {
  id: string;
  title: string;
  status: string;
  scheduledStart: string | null;
}

export interface SeededDomain {
  id: string;
  fullDomain: string;
  name: string;
  tld: string;
  status: string;
}

export interface SeededMailAccount {
  id: string;
  name: string;
  email: string;
  status: string;
}

export interface SeededMailLabel {
  id: string;
  accountId: string;
  name: string;
  color: string | null;
}

export interface MailAddress {
  email: string;
  name?: string;
}

/** A persisted mail_messages row, as returned by the mail fixtures. */
export interface SeededMailMessage {
  id: string;
  accountId: string;
  messageId: string;
  threadId: string | null;
  subject: string | null;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[] | null;
  bcc: MailAddress[] | null;
  labels: string[] | null;
  isRead: boolean;
  hasAttachments: boolean;
  attachmentCount: number | null;
  textBody: string | null;
  htmlBody: string | null;
  inReplyTo: string | null;
  references: string[] | null;
  isReply: boolean | null;
  source: string | null;
}

export interface SeededMailAttachment {
  id: string;
  messageId: string;
  fileName: string;
  contentType: string | null;
  size: number;
  storagePath: string | null;
}

export interface SeedMailMessageInput {
  accountId?: string;
  subject?: string;
  fromEmail?: string;
  fromName?: string;
  to?: string[];
  cc?: string[];
  labels?: string[];
  isRead?: boolean;
  textBody?: string;
  htmlBody?: string;
}

export interface SeedMailAttachmentInput {
  messageId: string;
  fileName?: string;
  contentType?: string;
  size?: number;
  storagePath?: string;
}

/** An attachment reference for the dry-run send/forward fixtures. `fileKey`
 * must start with `workspaces/<TEST_WORKSPACE_ID>/` for the happy path. */
export interface MailFixtureAttachment {
  filename: string;
  contentType?: string;
  size: number;
  fileKey: string;
}

export interface MailSendInput {
  accountId?: string;
  userId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: MailFixtureAttachment[];
  seedObjects?: boolean;
  /** Actually transmit via Cloudflare (skips dry-run). Deployed env + verified
   * sending domain only. Default false. */
  live?: boolean;
}

export interface MailReplyInput {
  originalMessageId: string;
  userId?: string;
  body?: string;
  htmlBody?: string;
  replyAll?: boolean;
  live?: boolean;
}

export interface MailForwardInput {
  originalMessageId: string;
  userId?: string;
  to: string[];
  body?: string;
  htmlBody?: string;
  attachments?: MailFixtureAttachment[];
  seedObjects?: boolean;
  live?: boolean;
}

export interface MailSendResult {
  messageId: string;
  smtpMessageId: string;
  subject: string;
  accountId: string;
  pendingVerification: boolean;
}

/** Response of the dry-run send/reply/forward fixtures: the SendResult plus the
 * persisted SENT message and its attachment rows for direct assertions. */
export interface MailSendResponse {
  result: MailSendResult;
  message: SeededMailMessage;
  attachments: SeededMailAttachment[];
  accountId?: string;
}

export interface SeededProduct {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface SeededOrder {
  id: string;
  orderNumber: string;
  status: string;
  total: string;
}

export interface SeededWorkflow {
  id: string;
  name: string;
  status: string;
  description: string | null;
}

export interface SeededWebhook {
  id: string;
  name: string;
  workflowId: string;
  description: string | null;
  isEnabled: boolean;
}

export interface SeededExecution {
  id: string;
  workflowId: string;
  workflowName: string | null;
  status: string;
  triggerType: string | null;
}

export interface SeededWeldstashProduct {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface SeededWeldstashSupplier {
  id: string;
  name: string;
  status: string | null;
}

export interface SeededWeldstashWarehouse {
  id: string;
  name: string;
  isDefault: boolean | null;
  isActive: boolean | null;
}

export interface SeededCalendarEvent {
  id: string;
  title: string;
  type: string;
  startTime: string;
}

export interface SeededBookingPage {
  id: string;
  name: string;
  slug: string;
}

export interface SeededVoipCall {
  id: string;
  direction: string;
  status: string;
  fromNumber: string;
  toNumber: string;
  userId: string;
  initiatedAt: string;
}

export interface SeededCustomFieldDefinition {
  id: string;
  entityType: string;
  name: string;
  slug: string;
  fieldType: string;
  description: string | null;
}

export interface SeededObjectTemplate {
  id: string;
  entityType: string;
  name: string;
  slug: string;
  description: string | null;
  fields: string[];
  isDefault: boolean;
}

export interface SeededCustomerStatus {
  id: string;
  name: string;
  slug: string;
  color: string;
  sortOrder: number;
}

export type SeedEntityType =
  | 'company'
  | 'person'
  | 'pipeline'
  | 'lead'
  | 'list'
  | 'project'
  | 'task'
  | 'opportunity'
  | 'activity'
  | 'sequence'
  | 'ticket'
  | 'meeting'
  | 'domain'
  | 'mailAccount'
  | 'mailLabel'
  | 'mailMessage'
  | 'mailAttachment'
  | 'product'
  | 'order'
  | 'workflow'
  | 'variable'
  | 'webhook'
  | 'execution'
  | 'weldstash-product'
  | 'weldstash-supplier'
  | 'weldstash-warehouse'
  | 'calendarEvent'
  | 'bookingPage'
  | 'voip-call'
  | 'customFieldDefinition'
  | 'objectTemplate'
  | 'customerStatus'
  | 'chatChannel'
  | 'chatMessage'
  | 'chatChannelMember';

export const testFixtures = {
  ping: () =>
    request<{ workspaceId: string; environment: string; marker: string }>(
      '/ping',
    ),

  reset: () => request<{ counts: Record<string, number> }>('/reset', {
    method: 'POST',
  }),

  seedCompany: (input: Partial<SeededCompany> = {}) =>
    request<SeededCompany>('/seed/company', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedPerson: (input: Partial<SeededPerson> = {}) =>
    request<SeededPerson>('/seed/person', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedPipeline: (input: Partial<SeededPipeline> = {}) =>
    request<SeededPipeline>('/seed/pipeline', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedLead: (input: Partial<SeededLead> = {}) =>
    request<SeededLead>('/seed/lead', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedList: (input: Partial<SeededList> = {}) =>
    request<SeededList>('/seed/list', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedProject: (input: Partial<SeededProject> = {}) =>
    request<SeededProject>('/seed/project', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedTask: (input: SeedTaskInput = {}) =>
    request<SeededTask>('/seed/task', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // --- WeldChat ---
  seedChatChannel: (input: SeedChatChannelInput = {}) =>
    request<SeededChatChannel>('/seed/chat-channel', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedChatMessage: (input: SeedChatMessageInput) =>
    request<SeededChatMessage>('/seed/chat-message', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedChatChannelMember: (input: SeedChatChannelMemberInput) =>
    request<SeededChatChannelMember>('/seed/chat-channel-member', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedOpportunity: (
    input: Partial<SeededOpportunity> & { ownerId?: string } = {},
  ) =>
    request<SeededOpportunity>('/seed/opportunity', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedActivity: (input: Partial<SeededActivity> = {}) =>
    request<SeededActivity>('/seed/activity', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedSequence: (input: Partial<SeededSequence> = {}) =>
    request<SeededSequence>('/seed/sequence', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedTicket: (input: Partial<SeededTicket> = {}) =>
    request<SeededTicket>('/seed/ticket', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedMeeting: (
    input: Partial<SeededMeeting> & {
      organizerId?: string;
      scheduledEnd?: string;
    } = {},
  ) =>
    request<SeededMeeting>('/seed/meeting', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedDomain: (input: Partial<SeededDomain> = {}) =>
    request<SeededDomain>('/seed/domain', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedMailAccount: (input: Partial<SeededMailAccount> = {}) =>
    request<SeededMailAccount>('/seed/mailAccount', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedMailLabel: (input: Partial<SeededMailLabel> = {}) =>
    request<SeededMailLabel>('/seed/mailLabel', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedMailMessage: (input: SeedMailMessageInput = {}) =>
    request<SeededMailMessage>('/seed/mail-message', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedMailAttachment: (input: SeedMailAttachmentInput) =>
    request<SeededMailAttachment>('/seed/mail-attachment', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Dry-run compose: runs the real send+persist (no MX/transmit) and returns
   * the persisted SENT message + attachments. */
  mailSend: (input: MailSendInput) =>
    request<MailSendResponse>('/mail/send', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  mailReply: (input: MailReplyInput) =>
    request<MailSendResponse>('/mail/reply', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  mailForward: (input: MailForwardInput) =>
    request<MailSendResponse>('/mail/forward', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedProduct: (input: Partial<SeededProduct> = {}) =>
    request<SeededProduct>('/seed/product', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedOrder: (
    input: Partial<SeededOrder> & {
      customerId?: string;
      customerEmail?: string;
      customerName?: string;
    } = {},
  ) =>
    request<SeededOrder>('/seed/order', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedWorkflow: (input: Partial<SeededWorkflow> = {}) =>
    request<SeededWorkflow>('/seed/workflow', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedWebhook: (input: Partial<SeededWebhook> = {}) =>
    request<SeededWebhook>('/seed/webhook', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedExecution: (
    input: Partial<SeededExecution> & {
      triggerType?: string;
      workflowId?: string;
    } = {},
  ) =>
    request<SeededExecution>('/seed/execution', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedWeldstashProduct: (
    input: Partial<SeededWeldstashProduct> & { sku?: string } = {},
  ) =>
    request<SeededWeldstashProduct>('/seed/weldstash-product', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedWeldstashSupplier: (
    input: Partial<SeededWeldstashSupplier> & {
      email?: string;
      contactName?: string;
    } = {},
  ) =>
    request<SeededWeldstashSupplier>('/seed/weldstash-supplier', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedWeldstashWarehouse: (
    input: Partial<SeededWeldstashWarehouse> & { code?: string } = {},
  ) =>
    request<SeededWeldstashWarehouse>('/seed/weldstash-warehouse', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedCalendarEvent: (
    input: Partial<SeededCalendarEvent> & {
      organizerId?: string;
      calendarId?: string;
    } = {},
  ) =>
    request<SeededCalendarEvent>('/seed/calendar-event', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedBookingPage: (
    input: Partial<SeededBookingPage> & {
      ownerId?: string;
      duration?: number;
    } = {},
  ) =>
    request<SeededBookingPage>('/seed/booking-page', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedVoipCall: (input: Partial<SeededVoipCall> = {}) =>
    request<SeededVoipCall>('/seed/voip-call', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedCustomFieldDefinition: (
    input: Partial<SeededCustomFieldDefinition> & { group?: string } = {},
  ) =>
    request<SeededCustomFieldDefinition>('/seed/custom-field-definition', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedObjectTemplate: (input: Partial<SeededObjectTemplate> = {}) =>
    request<SeededObjectTemplate>('/seed/object-template', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  seedCustomerStatus: (input: Partial<SeededCustomerStatus> = {}) =>
    request<SeededCustomerStatus>('/seed/customer-status', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * Installs apps for the test workspace (idempotent). A fresh E2E workspace
   * has zero apps, which makes AppAccessGuard redirect every module route to
   * home — so the whole authenticated module suite needs this run once up
   * front. Pass `apps` to install a subset; omit for the default full set.
   */
  installApps: (apps?: string[]) =>
    request<{ installed: string[]; members?: unknown[] }>('/install-apps', {
      method: 'POST',
      body: JSON.stringify({
        ...(apps ? { apps } : {}),
        // Grant the test user assignments for every app so they see all of
        // it even without an OWNER membership row.
        ...(process.env.TEST_USER_ID ? { userId: process.env.TEST_USER_ID } : {}),
      }),
    }),

  deleteEntity: (type: SeedEntityType, id: string) =>
    request<{ deleted: boolean }>(`/entity/${type}/${id}`, {
      method: 'DELETE',
    }),

  /**
   * Fully tears down a workspace created by the onboarding E2E spec: deletes
   * the Clerk organization, drops the Neon tenant DB, and removes the
   * master-DB workspace + membership rows. Idempotent — a second call (or a
   * call for an already-gone org) resolves to `{ ok: true }`. Refuses to
   * destroy the shared TEST_WORKSPACE_ID. Pass the throwaway org id captured
   * during the run.
   */
  teardownWorkspace: (clerkOrgId: string) =>
    request<{ ok: boolean }>('/teardown-workspace', {
      method: 'POST',
      body: JSON.stringify({ clerkOrgId }),
    }),
};
