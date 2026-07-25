/**
 * Per-event payload shapes.
 *
 * Each event carries a small, explicit, hand-declared interface — not a
 * type derived from a Drizzle schema. Decoupling from the DB on purpose:
 *
 *  - The wire shape is part of the *event contract* with subscribers
 *    (audit log, workflow engine, analytics, AI agents, realtime UI).
 *    Schema changes shouldn't silently mutate that contract.
 *  - Producers may flatten / rename fields before publishing (e.g. the
 *    publisher sees `firstName` + `lastName`, the event carries
 *    `fullName`).
 *  - Consumers can target this module without pulling `@weldsuite/db`
 *    into their type-only dependency graph.
 *
 * When the meaningful fields for an event change, edit the interface
 * here and update producers explicitly.
 *
 * Entities without a declared payload shape fall back to
 * `Record<string, unknown>` via `DataFor` — add a curated interface
 * below when the payload starts mattering downstream.
 */

import type { EntityType } from './index';

// ===========================================================================
// CRM
// ===========================================================================

export interface ContactEventData {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  customerId?: string | null;
  companyId?: string | null;
}

/** Same shape as Contact — "customer" is a contact flagged as customer. */
export type CustomerEventData = ContactEventData;

export interface PersonEventData {
  id: string;
  /** Optional — `deleted` only carries `id`. */
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  displayName?: string | null;
  email?: string | null;
  title?: string | null;
}

export interface CompanyEventData {
  id: string;
  /** Optional — the `deleted` action only carries `id`. */
  name?: string | null;
  website?: string | null;
  industry?: string | null;
  size?: string | null;
}

export interface LeadEventData {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  status: string;
  source?: string | null;
  ownerId?: string | null;
}

export interface OpportunityEventData {
  id: string;
  name: string;
  amount: string;
  currency?: string | null;
  stage: string;
  status: string;
  customerId?: string | null;
  pipelineId?: string | null;
  ownerId?: string | null;
  closeDate?: string | null;
}

export interface ActivityEventData {
  id: string;
  type: string;
  subject?: string | null;
  status?: string | null;
  contactId?: string | null;
  customerId?: string | null;
  assigneeId?: string | null;
  dueDate?: string | null;
}

export interface SupplierEventData {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
}

// ===========================================================================
// Projects + tasks
// ===========================================================================

export interface ProjectEventData {
  id: string;
  name: string;
  status?: string | null;
  priority?: string | null;
  customerId?: string | null;
  ownerId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface TaskEventData {
  id: string;
  title: string;
  status?: string | null;
  priority?: string | null;
  projectId?: string | null;
  assigneeId?: string | null;
  dueDate?: string | null;
  parentTaskId?: string | null;
  customerId?: string | null;
}

export interface TimeEntryEventData {
  id: string;
  taskId?: string | null;
  projectId?: string | null;
  userId: string;
  duration: number;
  startedAt?: string | null;
  endedAt?: string | null;
  /** Billed cost for the entry, when a rate applies. Consumed by analytics-worker. */
  cost?: number;
}

export interface ProjectMemberEventData {
  id: string;
  projectId: string;
  userId: string;
  role?: string | null;
}

// ===========================================================================
// Helpdesk
// ===========================================================================

export interface TicketEventData {
  id: string;
  ticketNumber?: string | null;
  subject?: string | null;
  status?: string | null;
  priority?: string | null;
  channel?: string | null;
  assigneeId?: string | null;
  contactId?: string | null;
  departmentId?: string | null;
}

export interface ConversationEventData {
  id: string;
  conversationNumber?: string | null;
  subject?: string | null;
  status?: string | null;
  priority?: string | null;
  channel?: string | null;
  assigneeId?: string | null;
  contactId?: string | null;
  departmentId?: string | null;
}

export interface ConversationMessageEventData {
  id: string;
  conversationId: string;
  authorId?: string | null;
  authorType?: string | null;
  content?: string | null;
  isInternal?: boolean | null;
}

// ===========================================================================
// Mail
// ===========================================================================

export interface MailMessageEventData {
  id: string;
  accountId: string;
  subject?: string | null;
  from?: string | null;
  to?: string[] | null;
  conversationId?: string | null;
}

export interface MailAccountEventData {
  id: string;
  email: string;
  provider?: string | null;
  status?: string | null;
}

export interface MailLabelEventData {
  id: string;
  accountId: string;
  name: string;
}

export interface MailDraftEventData {
  id: string;
  accountId: string;
  subject?: string | null;
}

export interface MailFolderEventData {
  id: string;
  accountId: string;
  name: string;
  type?: string | null;
}

export interface MailSignatureEventData {
  id: string;
  name: string;
  isDefault?: boolean | null;
}

export interface MailAttachmentEventData {
  id: string;
  messageId: string;
  fileName: string;
}

export interface MailTemplateEventData {
  id: string;
  name: string;
  type?: string | null;
}

export interface MailRuleEventData {
  id: string;
  accountId: string;
  name: string;
  isActive?: boolean | null;
}

export interface MailCampaignEventData {
  id: string;
  name: string;
  status?: string | null;
}

export interface MailDomainEventData {
  id: string;
  domainName: string;
  dnsStatus?: string | null;
  isPrimary?: boolean | null;
}

// ===========================================================================
// Accounting
// ===========================================================================

export interface InvoiceEventData {
  id: string;
  invoiceNumber?: string | null;
  status: string;
  total: string;
  currency?: string | null;
  contactId?: string | null;
  customerId?: string | null;
  dueDate?: string | null;
  issueDate?: string | null;
}

export interface BillEventData {
  id: string;
  billNumber?: string | null;
  status: string;
  total: string;
  currency?: string | null;
  contactId?: string | null;
  supplierId?: string | null;
  dueDate?: string | null;
  issueDate?: string | null;
}

export interface BankTransactionEventData {
  id: string;
  bankAccountId: string;
  amount: string;
  description?: string | null;
  date?: string | null;
  status?: string | null;
}

export interface PaymentEventData {
  id: string;
  invoiceId?: string | null;
  billId?: string | null;
  amount: string;
  currency?: string | null;
  date?: string | null;
  method?: string | null;
}

// ===========================================================================
// Commerce
// ===========================================================================

export interface OrderEventData {
  id: string;
  orderNumber?: string | null;
  status?: string | null;
  total?: string | null;
  currency?: string | null;
  customerId?: string | null;
  customerEmail?: string | null;
}

export interface ProductEventData {
  id: string;
  name: string;
  sku?: string | null;
  status?: string | null;
  price?: string | null;
  currency?: string | null;
}

// ===========================================================================
// WMS
// ===========================================================================

export interface InventoryEventData {
  id: string;
  productId: string;
  productName?: string | null;
  locationId?: string | null;
  quantity?: number | null;
  adjustmentType?: string | null;
}

// ===========================================================================
// Chat
// ===========================================================================

export interface ChatChannelEventData {
  id: string;
  name?: string | null;
  type?: string | null;
}

export interface ChatMessageEventData {
  id: string;
  channelId: string;
  authorId?: string | null;
  content?: string | null;
}

// ===========================================================================
// Workspace — workflows, notifications
// ===========================================================================

export interface WorkflowEventData {
  id: string;
  name: string;
  status?: string | null;
}

export interface WorkflowExecutionEventData {
  id: string;
  workflowId: string;
  status?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface NotificationEventData {
  id: string;
  title: string;
  body?: string | null;
  category?: string | null;
  actionUrl?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

// ===========================================================================
// Host (domains, DNS, VoIP)
// ===========================================================================

export interface DomainEventData {
  id: string;
  name: string;
  status?: string | null;
}

export interface DnsRecordEventData {
  id: string;
  zoneId: string;
  name?: string | null;
  type?: string | null;
  value?: string | null;
}

export interface DnsZoneEventData {
  id: string;
  name: string;
  status?: string | null;
}

export interface EmailForwardEventData {
  id: string;
  domainId: string;
  source: string;
  destination?: string | null;
  enabled?: boolean | null;
  status?: string | null;
}

export interface DomainTransferEventData {
  id: string;
  domainName: string;
  type: 'incoming' | 'outgoing';
  status?: string | null;
}

export interface VoipPhoneNumberEventData {
  id: string;
  phoneNumber: string;
  status?: string | null;
}

// ===========================================================================
// WeldDrive (files + folders)
// ===========================================================================

export interface FileEventData {
  id: string;
  name: string;
  folderId?: string | null;
  fileType?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  /** Resulting pin state, sent on the `pinned` action. */
  isPinned?: boolean;
}

export interface FolderEventData {
  id: string;
  name: string;
  parentId?: string | null;
}

export interface DocEventData {
  id: string;
  /** The drive file (files.id) this document is backed by. */
  fileId: string;
  updatedById?: string | null;
}

// ===========================================================================
// Calendar + meetings
// ===========================================================================

export interface CalendarEventEventData {
  id: string;
  title?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  calendarId?: string | null;
}

export interface MeetingEventData {
  id: string;
  title?: string | null;
  status?: string | null;
  startAt?: string | null;
  hostId?: string | null;
}

// ===========================================================================
// WeldData (lead database)
// ===========================================================================

export interface WelddataListEventData {
  id: string;
  name?: string | null;
  /** Number of leads saved in a `members_added` event. */
  count?: number | null;
}

export interface WelddataLeadEventData {
  id: string;
  listId?: string | null;
  kind?: string | null;
  name?: string | null;
  email?: string | null;
  companyName?: string | null;
  /** CRM ids stamped on `converted`. */
  convertedPersonId?: string | null;
  convertedCompanyId?: string | null;
}

export interface WelddataColumnEventData {
  id: string;
  listId?: string | null;
  name?: string | null;
  type?: string | null;
  /** Number of leads queued on a `run` event. */
  count?: number | null;
}

// ---------------------------------------------------------------------------
// Entity → payload map
// ---------------------------------------------------------------------------

export interface EntityEventData {
  // CRM
  contact: ContactEventData;
  customer: CustomerEventData;
  person: PersonEventData;
  company: CompanyEventData;
  lead: LeadEventData;
  opportunity: OpportunityEventData;
  activity: ActivityEventData;
  supplier: SupplierEventData;

  // Projects + tasks
  project: ProjectEventData;
  project_task: TaskEventData;
  project_member: ProjectMemberEventData;
  project_time_entry: TimeEntryEventData;
  task: TaskEventData;
  personal_task: TaskEventData;
  time_entry: TimeEntryEventData;

  // Helpdesk
  ticket: TicketEventData;
  helpdesk_ticket: TicketEventData;
  conversation: ConversationEventData;
  helpdesk_conversation: ConversationEventData;
  helpdesk_conversation_message: ConversationMessageEventData;

  // Mail
  email: MailMessageEventData;
  mail_account: MailAccountEventData;
  mail_attachment: MailAttachmentEventData;
  mail_campaign: MailCampaignEventData;
  mail_domain: MailDomainEventData;
  mail_draft: MailDraftEventData;
  mail_folder: MailFolderEventData;
  mail_label: MailLabelEventData;
  mail_signature: MailSignatureEventData;
  email_rule: MailRuleEventData;
  email_template: MailTemplateEventData;

  // Accounting
  invoice: InvoiceEventData;
  bill: BillEventData;
  bank_transaction: BankTransactionEventData;
  payment: PaymentEventData;

  // Commerce
  order: OrderEventData;
  commerce_order: OrderEventData;
  product: ProductEventData;

  // WMS
  inventory: InventoryEventData;
  wms_inventory: InventoryEventData;

  // Chat
  chat_channel: ChatChannelEventData;
  chat_message: ChatMessageEventData;

  // Workspace
  workflow: WorkflowEventData;
  workflow_execution: WorkflowExecutionEventData;
  notification: NotificationEventData;

  // Host
  domain: DomainEventData;
  dns_record: DnsRecordEventData;
  dns_zone: DnsZoneEventData;
  email_forward: EmailForwardEventData;
  domain_transfer: DomainTransferEventData;
  voip_phone_number: VoipPhoneNumberEventData;

  // WeldDrive
  file: FileEventData;
  folder: FolderEventData;
  doc: DocEventData;

  // Calendar + meetings
  calendar_event: CalendarEventEventData;
  meeting: MeetingEventData;

  // WeldData (lead database)
  welddata_list: WelddataListEventData;
  welddata_lead: WelddataLeadEventData;
  welddata_column: WelddataColumnEventData;
}

/**
 * Resolves to the declared payload shape for an entity, or a permissive
 * `Record<string, unknown>` fallback when no curated interface exists.
 *
 * Add a hand-declared interface above + an `EntityEventData` entry when
 * the payload contract starts mattering downstream.
 */
export type DataFor<E extends EntityType> = E extends keyof EntityEventData
  ? EntityEventData[E]
  : Record<string, unknown>;
