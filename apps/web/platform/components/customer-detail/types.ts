/**
 * Customer Detail Component Types
 *
 * Shared type definitions for the customer detail view component
 * used across CRM, Commerce, WMS, and Mail apps.
 *
 * NOTE: Types are defined locally to avoid importing from server-only modules
 * (like worker-client.ts) which would break client components.
 */

// ============================================================================
// Base Entity Types (copied from domain APIs to avoid server-only imports)
// ============================================================================

/**
 * Customer entity
 */
export interface Customer {
  id: string;
  type: 'b2c' | 'b2b';
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  companyName?: string;
  tradingName?: string;
  phone?: string;
  mobile?: string;
  website?: string;
  billingAddress?: any;
  shippingAddress?: any;
  segment?: string;
  status: string;
  source?: string;
  ownerId?: string;
  accountManagerId?: string;
  industry?: string;
  vatNumber?: string;
  registrationNumber?: string;
  paymentTerms?: string;
  currency?: string;
  tags?: string[];
  notes?: string;
  lifetimeValue?: number;
  totalRevenue?: number;
  employeeCount?: string;
  funding?: string;
  isFavorite?: boolean;
  customFields?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Contact entity
 */
interface Contact {
  id: string;
  customerId?: string;
  firstName: string;
  lastName: string;
  fullName?: string;
  email: string;
  title?: string;
  department?: string;
  directPhone?: string;
  mobilePhone?: string;
  extension?: string;
  role?: string;
  isPrimary?: boolean;
  isDecisionMaker?: boolean;
  isBillingContact?: boolean;
  isTechnicalContact?: boolean;
  influenceLevel?: string;
  preferredContactMethod?: string;
  preferredLanguage?: string;
  bestTimeToContact?: string;
  emailOptIn?: boolean;
  doNotCall?: boolean;
  linkedinUrl?: string;
  twitterHandle?: string;
  status: string;
  notes?: string;
  interests?: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Activity entity
 */
export interface Activity {
  id: string;
  type: string;
  subject: string;
  description?: string;
  relatedTo?: string;
  relatedToId?: string;
  relatedToName?: string;
  customerId?: string;
  contactId?: string;
  leadId?: string;
  opportunityId?: string;
  assignedToId: string;
  dueDate?: string;
  startTime?: string;
  endTime?: string;
  duration?: number;
  status: string;
  priority?: string;
  location?: string;
  isVirtual?: boolean;
  meetingUrl?: string;
  callDirection?: string;
  callDuration?: number;
  callRecordingUrl?: string;
  outcome?: string;
  nextAction?: string;
  followUpDate?: string;
  tags?: string[];
  customFields?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Opportunity entity
 */
export interface Opportunity {
  id: string;
  name: string;
  title?: string;
  description?: string;
  customerId: string;
  customerName?: string;
  primaryContactId?: string;
  amount?: string;
  value?: number;
  currency?: string;
  stage: string;
  stageId?: string;
  status: string;
  probability?: number;
  closeDate?: string;
  expectedCloseDate?: string;
  actualCloseDate?: string;
  ownerId: string;
  pipeline?: string;
  leadSource?: string;
  campaign?: string;
  type?: string;
  nextStep?: string;
  nextStepDate?: string;
  winLossReason?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Customer list entity
 */
interface CustomerList {
  id: string;
  name: string;
  color: string;
  icon: string;
  description?: string;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Customer Detail Specific Types
// ============================================================================

/**
 * Order from Commerce module (simplified for customer context)
 */
export interface CustomerOrder {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  currency: string;
  subtotal: string;
  total: string;
  itemCount: number;
  source?: string;
  customerNote?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Invoice (placeholder - extend when invoice module is available)
 */
export interface CustomerInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  amount: string;
  currency: string;
  dueDate: string;
  paidAt?: string;
  createdAt: string;
}

/**
 * Customer list membership with additional join data
 */
interface CustomerListMembership {
  id: string;
  name: string;
  color: string;
  icon: string;
  description?: string;
  addedAt: string;
}

/**
 * Contact with role info from junction table
 */
export interface CustomerContact {
  id: string;
  firstName: string;
  lastName: string;
  fullName?: string;
  email: string;
  title?: string;
  department?: string;
  directPhone?: string;
  mobilePhone?: string;
  role?: string;
  isPrimary?: boolean;
  status: string;
  createdAt: string;
  avatarUrl?: string;
}

/**
 * Counts for all customer-related entities
 */
interface CustomerDetailCounts {
  contacts: number;
  activities: number;
  opportunities: number;
  orders: number;
  invoices: number;
  notes: number;
  tasks: number;
}

/**
 * Complete customer detail data returned by unified endpoint
 */
export interface CustomerDetailData {
  customer: Customer;
  contacts: CustomerContact[];
  activities: Activity[];
  opportunities: Opportunity[];
  orders: CustomerOrder[];
  invoices: CustomerInvoice[];
  lists: CustomerListMembership[];
  counts: CustomerDetailCounts;
  lastActivity: string | null;
}

// ============================================================================
// Component Types
// ============================================================================

/**
 * Display mode for the customer detail view
 * - page: Full page layout with sidebar (CRM customer detail page)
 * - panel: Sliding panel from right (Mail app, order views)
 * - embedded: Compact view without header/sidebar (embedded in other pages)
 */
export type CustomerDetailMode = 'page' | 'panel' | 'embedded';

/**
 * Entity type for the detail view
 * - customer: CRM customer (default)
 * - contact: CRM contact
 */
export type CustomerDetailEntityType = 'customer' | 'contact';

/**
 * Available tabs in the customer detail view
 */
export type CustomerDetailTab =
  | 'overview'
  | 'activity'
  | 'contacts'
  | 'deals'
  | 'notes'
  | 'emails'
  | 'calls'
  | 'tasks'
  | 'meetings'
  | 'files'
  | 'orders'
  | 'invoices'
  | 'audit'
  | 'chat';

/**
 * Sidebar tab options
 */
export type CustomerDetailSidebarTab = 'details' | 'comments';

/**
 * Navigation data for prev/next customer navigation
 */
export interface CustomerNavigationData {
  currentIndex: number;
  totalCount: number;
  previousId: string | null;
  nextId: string | null;
  contextName: string;
}

/**
 * Main props for the CustomerDetailView component
 */
export interface CustomerDetailViewProps {
  // Required
  customerId: string;

  // Entity type (customer or contact)
  entityType?: CustomerDetailEntityType;

  // Display mode (determines layout)
  mode?: CustomerDetailMode;

  // Panel-specific props
  isOpen?: boolean;
  onClose?: () => void;
  width?: string;
  topOffset?: string;
  isExpanded?: boolean;
  onToggleExpand?: () => void;

  // Data props
  initialData?: CustomerDetailData;

  // Feature toggles (for customization)
  showHeader?: boolean;
  showTabs?: boolean;
  showSidebar?: boolean;
  defaultTab?: CustomerDetailTab;

  // Callbacks
  onNavigateToCustomer?: (customerId: string) => void;
  onCompose?: (email: string) => void;
  onCall?: (phone: string) => void;
  onDelete?: () => void;

  // Navigation context
  listId?: string;
  returnUrl?: string;
  navigation?: CustomerNavigationData;

  // Extra data (e.g. from helpdesk conversation)
  visitorLocation?: { city?: string; region?: string; country?: string; timezone?: string } | null;

  // When provided, renders a back chevron at the top of the panel header.
  // Used when this panel is opened stacked on top of another panel (e.g. the
  // customer panel's Contacts tab opening a contact). Also makes the X button
  // dispatch `close-detail-panels` so both panels close together, and skips
  // the panel-width layout event so the parent panel's width reservation
  // stays in effect (no page-content shift).
  onBack?: () => void;
}

/**
 * Context value for customer detail data
 */
export interface CustomerDetailContextValue {
  // Data
  data: CustomerDetailData | null;
  isLoading: boolean;
  error: string | null;

  // Navigation
  navigation: CustomerNavigationData | null;

  // State
  activeTab: CustomerDetailTab;
  setActiveTab: (tab: CustomerDetailTab) => void;
  sidebarTab: CustomerDetailSidebarTab;
  setSidebarTab: (tab: CustomerDetailSidebarTab) => void;

  // Actions
  refresh: () => Promise<void>;
  silentRefresh: () => Promise<void>;

  // Props pass-through
  mode: CustomerDetailMode;
  entityType: CustomerDetailEntityType;
  customerId: string;
  listId?: string;
  returnUrl?: string;
  showHeader: boolean;
  showTabs: boolean;
  showSidebar: boolean;
  onCompose?: (email: string) => void;
  onCall?: (phone: string) => void;
  onClose?: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  countOverrides: Partial<CustomerDetailCounts>;
  setCountOverride: (key: keyof CustomerDetailCounts, value: number) => void;
  pendingNoteCreate: boolean;
  setPendingNoteCreate: (value: boolean) => void;
  floatingNote: import('./note-editor-dialog').Note | null;
  setFloatingNote: (note: import('./note-editor-dialog').Note | null) => void;
  showFloatingNoteEditor: boolean;
  setShowFloatingNoteEditor: (value: boolean) => void;
  showTaskDialog: boolean;
  setShowTaskDialog: (value: boolean) => void;
  visitorLocation?: { city?: string; region?: string; country?: string; timezone?: string } | null;
}

/**
 * Props for section components
 */
export interface SectionProps {
  customer: Customer;
  className?: string;
}

export interface OverviewSectionProps extends SectionProps {
  contacts: CustomerContact[];
  opportunities: Opportunity[];
  lastActivity: string | null;
  counts: CustomerDetailCounts;
}

export interface ActivitySectionProps extends SectionProps {
  activities: Activity[];
  totalCount: number;
}

export interface ContactsSectionProps extends SectionProps {
  contacts: CustomerContact[];
  totalCount: number;
}

export interface DealsSectionProps extends SectionProps {
  opportunities: Opportunity[];
  totalCount: number;
}

export interface NotesSectionProps extends SectionProps {
  activities: Activity[];
  totalCount: number;
}

export interface EmailsSectionProps extends SectionProps {
  // Future: email data
}

export interface CallsSectionProps extends SectionProps {
  activities: Activity[];
}

export interface TasksSectionProps extends SectionProps {
  // Future: task data
}

export interface FilesSectionProps extends SectionProps {
  // Future: file data
}

export interface OrdersSectionProps extends SectionProps {
  orders: CustomerOrder[];
  totalCount: number;
}

export interface InvoicesSectionProps extends SectionProps {
  invoices: CustomerInvoice[];
  totalCount: number;
}
