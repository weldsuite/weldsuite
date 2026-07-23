/**
 * Platform Event Types
 *
 * Type definitions for platform-wide real-time events.
 * These events flow through the workspace channel to notify
 * all connected users about entity changes.
 */

/**
 * Entity action types
 */
type EntityAction = 'created' | 'updated' | 'deleted' | 'archived';

/**
 * Event source - where the mutation originated
 */
type EventSource = 'web' | 'mobile' | 'api' | 'system';

/**
 * Event metadata included with every platform event
 */
interface EventMetadata {
  workspaceId: string;
  userId: string;
  userName?: string;
  timestamp: string;
  source: EventSource;
}

/**
 * Base platform event structure
 */
interface PlatformEvent<T = unknown> {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  action: EntityAction;
  data: T;
  metadata: EventMetadata;
}

// ============================================
// Project Events
// ============================================

interface ProjectEventData {
  id: string;
  name: string;
  status?: string;
  priority?: string;
  health?: string;
  progress?: number;
  clientName?: string;
  endDate?: string;
  changes?: Record<string, unknown>;
}

interface ProjectEvent extends PlatformEvent<ProjectEventData> {
  entityType: 'project';
}

export interface ProjectMemberEventData {
  projectId: string;
  projectName: string;
  memberId: string;
  memberName?: string;
  role?: string;
}

interface ProjectMemberEvent extends PlatformEvent<ProjectMemberEventData> {
  entityType: 'project_member';
}

interface ProjectDocumentEventData {
  id: string;
  projectId: string;
  title: string;
  changes?: Record<string, unknown>;
}

interface ProjectDocumentEvent extends PlatformEvent<ProjectDocumentEventData> {
  entityType: 'project_document';
}

interface ProjectFileEventData {
  id: string;
  projectId: string;
  fileName: string;
  fileType?: string;
  changes?: Record<string, unknown>;
}

interface ProjectFileEvent extends PlatformEvent<ProjectFileEventData> {
  entityType: 'project_file';
}

interface ProjectGoalEventData {
  id: string;
  projectId: string;
  title?: string;
  changes?: Record<string, unknown>;
}

interface ProjectGoalEvent extends PlatformEvent<ProjectGoalEventData> {
  entityType: 'project_goal';
}

export interface ProjectMessageEventData {
  id: string;
  projectId: string;
  senderId: string;
  senderName?: string;
  message?: string;
  changes?: Record<string, unknown>;
}

interface ProjectMessageEvent extends PlatformEvent<ProjectMessageEventData> {
  entityType: 'project_message';
}

interface ProjectWhiteboardEventData {
  id: string;
  projectId: string;
  changes?: Record<string, unknown>;
}

interface ProjectWhiteboardEvent extends PlatformEvent<ProjectWhiteboardEventData> {
  entityType: 'project_whiteboard';
}

interface TimeEntryEventData {
  id: string;
  projectId?: string;
  taskId?: string;
  userId: string;
  duration?: number;
  description?: string;
  changes?: Record<string, unknown>;
}

interface TimeEntryEvent extends PlatformEvent<TimeEntryEventData> {
  entityType: 'time_entry';
}

interface MilestoneEventData {
  id: string;
  projectId: string;
  name: string;
  dueDate?: string;
  status?: string;
  changes?: Record<string, unknown>;
}

interface MilestoneEvent extends PlatformEvent<MilestoneEventData> {
  entityType: 'milestone';
}

// ============================================
// Task Events
// ============================================

export interface TaskEventData {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  assigneeId?: string;
  assigneeName?: string;
  status?: string;
  priority?: string;
  description?: string;
  dueDate?: string;
  startDate?: string;
  tags?: string[];
  createdAt?: string;
  changes?: Record<string, unknown>;
}

interface TaskEvent extends PlatformEvent<TaskEventData> {
  entityType: 'task';
}

// ============================================
// CRM Events
// ============================================

interface ContactEventData {
  id: string;
  name: string;
  email?: string;
  companyId?: string;
  companyName?: string;
  changes?: Record<string, unknown>;
}

interface ContactEvent extends PlatformEvent<ContactEventData> {
  entityType: 'contact';
}

interface CompanyEventData {
  id: string;
  name: string;
  website?: string;
  changes?: Record<string, unknown>;
}

interface CompanyEvent extends PlatformEvent<CompanyEventData> {
  entityType: 'company';
}

interface LeadEventData {
  id: string;
  name: string;
  email?: string;
  status?: string;
  changes?: Record<string, unknown>;
}

interface LeadEvent extends PlatformEvent<LeadEventData> {
  entityType: 'lead';
}

interface OpportunityEventData {
  id: string;
  name: string;
  value?: number;
  stage?: string;
  contactId?: string;
  companyId?: string;
  changes?: Record<string, unknown>;
}

interface OpportunityEvent extends PlatformEvent<OpportunityEventData> {
  entityType: 'opportunity';
}

// ============================================
// WMS Events
// ============================================

interface ProductEventData {
  id: string;
  name: string;
  sku?: string;
  changes?: Record<string, unknown>;
}

interface ProductEvent extends PlatformEvent<ProductEventData> {
  entityType: 'product';
}

interface InventoryEventData {
  id: string;
  productId: string;
  productName?: string;
  locationId?: string;
  quantity?: number;
  adjustmentType?: string;
  changes?: Record<string, unknown>;
}

interface InventoryEvent extends PlatformEvent<InventoryEventData> {
  entityType: 'inventory';
}

// ============================================
// Commerce Events
// ============================================

interface CommerceOrderEventData {
  id: string;
  orderNumber?: string;
  status?: string;
  customerName?: string;
  total?: number;
  changes?: Record<string, unknown>;
}

interface CommerceOrderEvent extends PlatformEvent<CommerceOrderEventData> {
  entityType: 'commerce_order';
}

// ============================================
// Accounting Events
// ============================================

interface InvoiceEventData {
  id: string;
  invoiceNumber?: string;
  status?: string;
  customerName?: string;
  total?: number;
  changes?: Record<string, unknown>;
}

interface InvoiceEvent extends PlatformEvent<InvoiceEventData> {
  entityType: 'invoice';
}

interface BillEventData {
  id: string;
  billNumber?: string;
  status?: string;
  vendorName?: string;
  total?: number;
  changes?: Record<string, unknown>;
}

interface BillEvent extends PlatformEvent<BillEventData> {
  entityType: 'bill';
}

interface PaymentEventData {
  id: string;
  amount: number;
  type: 'received' | 'sent';
  relatedEntityId?: string;
  relatedEntityType?: string;
  changes?: Record<string, unknown>;
}

interface PaymentEvent extends PlatformEvent<PaymentEventData> {
  entityType: 'payment';
}

// ============================================
// Helpdesk Events
// ============================================

interface TicketEventData {
  id: string;
  ticketNumber?: string;
  subject: string;
  status?: string;
  priority?: string;
  assigneeId?: string;
  assigneeName?: string;
  changes?: Record<string, unknown>;
}

interface TicketEvent extends PlatformEvent<TicketEventData> {
  entityType: 'ticket';
}

// ============================================
// Notification Events
// ============================================

interface NotificationEventData {
  id: string;
  title: string;
  body: string;
  category?: string;
  actionUrl?: string;
  entityType?: string;
  entityId?: string;
}

interface NotificationEvent extends PlatformEvent<NotificationEventData> {
  entityType: 'notification';
}

// ============================================
// Union Type
// ============================================

export type AnyPlatformEvent =
  | ProjectEvent
  | ProjectMemberEvent
  | ProjectDocumentEvent
  | ProjectFileEvent
  | ProjectGoalEvent
  | ProjectMessageEvent
  | ProjectWhiteboardEvent
  | TimeEntryEvent
  | MilestoneEvent
  | TaskEvent
  | ContactEvent
  | CompanyEvent
  | LeadEvent
  | OpportunityEvent
  | ProductEvent
  | InventoryEvent
  | CommerceOrderEvent
  | InvoiceEvent
  | BillEvent
  | PaymentEvent
  | TicketEvent
  | NotificationEvent
  | PlatformEvent<unknown>;

// ============================================
// Event Type Constants
// ============================================

const PLATFORM_EVENT_TYPES = {
  // Projects
  PROJECT_CREATED: 'project:created',
  PROJECT_UPDATED: 'project:updated',
  PROJECT_DELETED: 'project:deleted',
  PROJECT_ARCHIVED: 'project:archived',
  PROJECT_MEMBER_ADDED: 'project_member:created',
  PROJECT_MEMBER_UPDATED: 'project_member:updated',
  PROJECT_MEMBER_REMOVED: 'project_member:deleted',
  PROJECT_DOCUMENT_UPDATED: 'project_document:updated',
  PROJECT_FILE_CREATED: 'project_file:created',
  PROJECT_FILE_UPDATED: 'project_file:updated',
  PROJECT_FILE_DELETED: 'project_file:deleted',
  PROJECT_GOAL_UPDATED: 'project_goal:updated',
  PROJECT_MESSAGE_CREATED: 'project_message:created',
  PROJECT_MESSAGE_UPDATED: 'project_message:updated',
  PROJECT_MESSAGE_DELETED: 'project_message:deleted',
  PROJECT_WHITEBOARD_UPDATED: 'project_whiteboard:updated',

  // Time Entries
  TIME_ENTRY_CREATED: 'time_entry:created',
  TIME_ENTRY_UPDATED: 'time_entry:updated',
  TIME_ENTRY_DELETED: 'time_entry:deleted',

  // Milestones
  MILESTONE_CREATED: 'milestone:created',
  MILESTONE_UPDATED: 'milestone:updated',
  MILESTONE_DELETED: 'milestone:deleted',

  // Tasks
  TASK_CREATED: 'task:created',
  TASK_UPDATED: 'task:updated',
  TASK_DELETED: 'task:deleted',
  TASK_ASSIGNED: 'task:assigned',

  // CRM
  CONTACT_CREATED: 'contact:created',
  CONTACT_UPDATED: 'contact:updated',
  CONTACT_DELETED: 'contact:deleted',
  COMPANY_CREATED: 'company:created',
  COMPANY_UPDATED: 'company:updated',
  COMPANY_DELETED: 'company:deleted',
  LEAD_CREATED: 'lead:created',
  LEAD_UPDATED: 'lead:updated',
  LEAD_DELETED: 'lead:deleted',
  OPPORTUNITY_CREATED: 'opportunity:created',
  OPPORTUNITY_UPDATED: 'opportunity:updated',
  OPPORTUNITY_DELETED: 'opportunity:deleted',

  // WMS
  PRODUCT_CREATED: 'product:created',
  PRODUCT_UPDATED: 'product:updated',
  PRODUCT_DELETED: 'product:deleted',
  INVENTORY_ADJUSTED: 'inventory:updated',
  // Commerce
  COMMERCE_ORDER_CREATED: 'commerce_order:created',
  COMMERCE_ORDER_UPDATED: 'commerce_order:updated',

  // Accounting
  INVOICE_CREATED: 'invoice:created',
  INVOICE_UPDATED: 'invoice:updated',
  BILL_CREATED: 'bill:created',
  BILL_UPDATED: 'bill:updated',
  PAYMENT_RECEIVED: 'payment:created',

  // Helpdesk
  TICKET_CREATED: 'ticket:created',
  TICKET_UPDATED: 'ticket:updated',
  TICKET_ASSIGNED: 'ticket:assigned',

  // Notifications
  NOTIFICATION_NEW: 'notification:created',
} as const;

type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[keyof typeof PLATFORM_EVENT_TYPES];

// ============================================
// Connection State
// ============================================

export type PlatformConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'suspended'
  | 'failed';
