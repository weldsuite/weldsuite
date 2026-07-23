/**
 * CRM Domain Types
 *
 * Shared TypeScript types for the WeldCRM surface (customers, contacts, leads,
 * opportunities, pipelines, lists, sequences).
 *
 * This module is types-only. The CRM data plane lives on `apps/workers/app-api` and is
 * reached through the `useAppApi*` hooks in `hooks/queries/use-*-queries.ts`,
 * which import the types from here. The legacy `crmWorkerApi` object that used
 * to sit in this file was removed during the api-worker phase-out: it had no
 * call sites, and the api-worker routes it targeted (`/crm/customers`,
 * `/crm/contacts`, `/crm/lists`, `/crm/sequences`, `/crm/activities`) were
 * already retired in the companies/people refactor.
 */

// ============================================================================
// Types
// ============================================================================

export interface Customer {
  id: string;
  /** Optimistic-concurrency cursor — sent back as `ifVersion` on writes. */
  version?: number;
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
  industry?: string;
  vatNumber?: string;
  registrationNumber?: string;
  paymentTerms?: string;
  currency?: string;
  avatarUrl?: string;
  isFavorite?: boolean;
  tags?: string[];
  notes?: string;
  customFields?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface Supplier {
  id: string;
  name: string;
  code?: string;
  description?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  website?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  paymentTerms?: string;
  currency?: string;
  creditLimit?: string;
  taxId?: string;
  defaultLeadTimeDays?: number;
  minimumOrderValue?: string;
  isActive?: boolean;
  status?: string;
  rating?: number;
  notes?: string;
  metadata?: Record<string, any>;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

interface ContactCustomerLink {
  id: string;
  contactId?: string;
  customerId: string;
  isPrimary?: boolean;
  role?: string;
  createdAt?: string;
  customer?: {
    id: string;
    companyName?: string;
    tradingName?: string;
    email?: string;
    type?: string;
    status?: string;
  };
}

interface ContactSupplierLink {
  id: string;
  contactId?: string;
  supplierId: string;
  isPrimary?: boolean;
  role?: string;
  createdAt?: string;
  supplier?: {
    id: string;
    name?: string;
    code?: string;
    email?: string;
    status?: string;
  };
}

export interface Contact {
  id: string;
  /** @deprecated Use customerLinks for many-to-many relationships */
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
  // Many-to-many relationships
  customerLinks?: ContactCustomerLink[];
  supplierLinks?: ContactSupplierLink[];
}

export interface Lead {
  id: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email: string;
  companyName?: string;
  title?: string;
  phone?: string;
  mobile?: string;
  website?: string;
  address?: any;
  source: string;
  channel?: string;
  campaign?: string;
  medium?: string;
  status: string;
  rating?: string;
  score?: number;
  ownerId?: string;
  isQualified?: boolean;
  qualifiedAt?: string;
  productInterest?: string[];
  budget?: any;
  timeline?: string;
  authority?: boolean;
  need?: string;
  notes?: string;
  nextAction?: string;
  convertedAt?: string;
  convertedToCustomerId?: string;
  convertedToOpportunityId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Opportunity {
  id: string;
  name: string;
  description?: string;
  customerId: string;
  customerName?: string;
  primaryContactId?: string;
  contactId?: string;
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
  title?: string;
  nextStep?: string;
  nextStepDate?: string;
  winLossReason?: string;
  lostReason?: string;
  tags?: string[];
  contact?: { id?: string; name?: string };
  company?: { id?: string; name?: string };
  owner?: { id?: string; name?: string };
  createdAt: string;
  updatedAt: string;
}

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  template?: string;
  isDefault?: boolean;
  isArchived?: boolean;
  settings?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineStage {
  id: string;
  name: string;
  description?: string;
  color?: string;
  probability?: number;
  pipeline: string;
  position: number;
  isDefault?: boolean;
  isWon?: boolean;
  isLost?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: PaginationMeta;
}

export interface SingleResponse<T> {
  success: boolean;
  data: T;
}

export interface LeadFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  source?: string;
  rating?: string;
  ownerId?: string;
  isQualified?: string;
}

export interface OpportunityFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  stage?: string;
  pipeline?: string;
  ownerId?: string;
  customerId?: string;
  contactId?: string;
  limit?: number;
  cursor?: string;
}

export interface CustomerList {
  id: string;
  name: string;
  color: string;
  icon: string;
  description?: string;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerListFilters {
  page?: number;
  pageSize?: number;
  search?: string;
}

// Sequence types
export interface SequenceSummary {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  steps: any[];
  tags: string[];
  executionCount: number;
  successCount: number;
  lastExecutedAt: string | null;
  createdAt: string;
  updatedAt: string;
  enrolledCount: number;
  activeEnrolledCount: number;
  pendingEnrolledCount: number;
}

export interface SequenceDetail extends SequenceSummary {
  triggers: any[];
  settings: Record<string, any>;
  failureCount: number;
  completedEnrolledCount: number;
  failedEnrolledCount: number;
}

export interface SequenceEnrollment {
  id: string;
  sequenceId: string;
  customerId: string;
  status: string;
  executionId?: string;
  currentStepIndex: number;
  totalSteps: number;
  enrolledBy?: string;
  enrolledAt: string;
  completedAt?: string;
  pausedAt?: string;
  unenrolledAt?: string;
  failedAt?: string;
  errorMessage?: string;
  customerSnapshot?: {
    email?: string;
    firstName?: string;
    lastName?: string;
    companyName?: string;
  };
  customerEmail?: string;
  customerFirstName?: string;
  customerLastName?: string;
  customerFullName?: string;
  customerCompanyName?: string;
  customerType?: string;
}

export interface SequenceEnrollmentFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
}

export interface CustomerSequenceEntry {
  enrollmentId: string;
  sequenceId: string;
  status: string;
  currentStepIndex: number;
  totalSteps: number;
  enrolledAt: string;
  completedAt?: string;
  sequenceName: string;
  sequenceStatus: string;
}

export interface CustomerListMemberFilters {
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  description: string;
  href: string;
  type: string;
}
