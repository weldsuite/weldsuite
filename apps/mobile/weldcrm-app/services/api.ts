/**
 * WeldCRM mobile data layer, backed by the first-party API (see `app-api.ts`
 * for how a path reaches the right worker).
 *
 * The surface mirrors the platform's WeldCRM:
 *
 *   people          GET/POST/PATCH/DELETE /api/people, /:id/companies, /:id/archive|unarchive
 *   companies       GET/POST/PATCH/DELETE /api/companies, /:id/people, /:id/archive|unarchive
 *   links           POST/DELETE /api/person-companies
 *   activities      GET/POST /api/activities (timeline; call, email, meeting, note)
 *   pipelines       GET /api/pipelines + /api/pipeline-stages?pipeline=
 *   deals           GET/POST/PATCH/DELETE /api/opportunities (customerId is a COMPANY id)
 *   members         GET /api/team-members (owner / manager / assignee pickers)
 *   custom fields   GET /api/custom-fields?entityType=
 *   statuses        GET /api/customer-statuses
 *   dashboard       derived from the list endpoints' totals
 *   currency        GET /api/workspace-settings
 *
 * Tasks live in `tasks.ts` (flow-api `/tasks`, like the platform's My Tasks),
 * notes in `notes.ts`, the record tabs (emails, calls, …) in `record-tabs.ts`.
 *
 * The API returns `{ data }` / `{ data, pagination }` envelopes and throws on
 * non-2xx. Every method here catches that and returns `{ success, data }` /
 * `{ success: false, error }` so screens never need a try/catch around a call.
 *
 * Mind the server's PATCH schemas: they drop unknown keys without an error, and
 * `customFields` REPLACES the stored map, so callers send the whole map.
 */

import type { ApiResponse } from '@weldsuite/mobile-ui/types';
import { appApiClient } from './app-api';
import { recordOfActivity, recordLinkPayload, type RecordRef } from './notes';
import { resolveName, type LoggableActivityType } from '@/lib/crm';
import { DEFAULT_CURRENCY, resolveCurrency, sumInCurrency, toNumber } from '@/lib/money';

// ============================================================================
// Public types
// ============================================================================

/** One page of a cursor-paginated list. */
export interface Page<T> {
  items: T[];
  totalCount: number;
  hasMore: boolean;
  /** Pass back as `cursor` to load the next page. */
  cursor: string | null;
}

export type CustomFieldValues = Record<string, unknown>;

export interface Address {
  line1?: string;
  line2?: string;
  postalCode?: string;
  city?: string;
  state?: string;
  country?: string;
}

export interface CrmDashboardStats {
  totalPeople: number;
  totalCompanies: number;
  /** People and companies flagged as a lead. */
  leads: number;
  openDeals: number;
  wonDeals: number;
  /** Sum of won deals in `currency`. */
  revenue: number;
  /** The workspace currency `revenue` is in. */
  currency: string;
  /** Won deals left out of `revenue` because they are in another currency. */
  revenueExcluded: number;
  /** True when there are more won deals than the pages that were read. */
  revenuePartial: boolean;
  /** How many won deals were read for `revenue`. */
  revenueDealsRead: number;
}

/** An activity on the timeline (call, email, meeting, note, task, …). */
export interface CrmActivity {
  id: string;
  type: string;
  subject: string;
  description?: string;
  status?: string;
  record?: RecordRef;
  assignedToId?: string;
  /** ISO timestamp the activity was created. */
  createdAt: string;
}

export interface PersonRecord {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  department?: string;
  email: string;
  phone?: string;
  mobile?: string;
  status?: string;
  lifecycleStage?: string;
  ownerId?: string;
  accountManagerId?: string;
  tags: string[];
  /** ISO 639-1 code. */
  language?: string;
  linkedinUrl?: string;
  address?: Address;
  isLead: boolean;
  isSupplier: boolean;
  notes?: string;
  customFields: CustomFieldValues;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyRecord {
  id: string;
  name: string;
  industry?: string;
  website?: string;
  email: string;
  phone?: string;
  mobile?: string;
  description?: string;
  status?: string;
  lifecycleStage?: string;
  ownerId?: string;
  accountManagerId?: string;
  tags: string[];
  vatNumber?: string;
  registrationNumber?: string;
  employeeCount?: string;
  language?: string;
  address?: Address;
  isLead: boolean;
  isSupplier: boolean;
  customFields: CustomFieldValues;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A company a person works at (from `GET /people/:id/companies`). */
export interface PersonCompany {
  linkId: string;
  companyId: string;
  name: string;
  industry?: string;
  role?: string;
  isPrimary: boolean;
}

/** A person who works at a company (from `GET /companies/:id/people`). */
export interface CompanyPerson {
  linkId: string;
  personId: string;
  name: string;
  email?: string;
  role?: string;
  isPrimary: boolean;
}

/**
 * Fields a person can be created or saved with. `null` clears a field the
 * API lets us clear; `undefined` leaves it alone.
 */
export interface PersonInput {
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  department?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  notes?: string;
  status?: string;
  lifecycleStage?: string | null;
  ownerId?: string | null;
  accountManagerId?: string | null;
  tags?: string[];
  language?: string;
  linkedinUrl?: string;
  address?: Address | null;
  isLead?: boolean;
  isSupplier?: boolean;
  customFields?: CustomFieldValues;
  /** Create only: the company the person works at; becomes their primary company. */
  companyId?: string;
}

export interface CompanyInput {
  name?: string;
  industry?: string;
  website?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  description?: string;
  status?: string;
  lifecycleStage?: string | null;
  ownerId?: string | null;
  accountManagerId?: string | null;
  tags?: string[];
  vatNumber?: string;
  registrationNumber?: string;
  employeeCount?: string;
  language?: string;
  address?: Address | null;
  isLead?: boolean;
  isSupplier?: boolean;
  customFields?: CustomFieldValues;
}

export interface ActivityInput {
  type: LoggableActivityType;
  subject: string;
  description?: string;
  /** The company or person the activity is about. */
  record?: RecordRef;
  /** A deal the activity belongs to. */
  opportunityId?: string;
}

export interface PipelineStage {
  id: string;
  name: string;
  color?: string;
  position: number;
  pipelineId: string;
  probability?: number;
  isWon: boolean;
  isLost: boolean;
}

export interface PipelineWithStages {
  id: string;
  name: string;
  color?: string;
  stages: PipelineStage[];
}

export type DealStatus = 'open' | 'won' | 'lost' | 'abandoned';

export interface DealRecord {
  id: string;
  name: string;
  /** Decimal string as stored, e.g. "1250.00". */
  value?: string;
  currency?: string;
  stageId?: string;
  pipelineId?: string;
  status: string;
  /** The company the deal is with. */
  companyId?: string;
  companyName?: string;
  primaryContactId?: string;
  expectedCloseDate?: string;
  actualCloseDate?: string;
  probability?: number;
  description?: string;
  ownerId?: string;
  leadSource?: string;
  type?: string;
  nextStep?: string;
  tags: string[];
  customFields: CustomFieldValues;
  createdAt: string;
  updatedAt: string;
}

export interface DealInput {
  name: string;
  companyId: string;
  amount?: number;
  currency?: string;
  stageId?: string;
  probability?: number;
  /** ISO date; left out when not set, so the deal has no close date (as on the web). */
  closeDate?: string;
  notes?: string;
  pipelineId?: string;
  primaryContactId?: string;
}

/** Fields a deal can be saved with; `null` clears what the API lets us clear. */
export interface DealUpdate {
  name?: string;
  amount?: number;
  currency?: string;
  stageId?: string;
  status?: DealStatus;
  probability?: number;
  closeDate?: string | null;
  description?: string;
  ownerId?: string;
  leadSource?: string;
  type?: string;
  nextStep?: string;
  tags?: string[];
  customFields?: CustomFieldValues;
  companyId?: string;
  primaryContactId?: string;
}

/** A workspace member, for owner / manager / assignee pickers. */
export interface Member {
  /** The Clerk user id: what `ownerId`, `assigneeIds` etc. store. */
  userId: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

export type CustomFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'single_select'
  | 'multi_select'
  | 'boolean'
  | 'url'
  | 'email'
  | 'phone'
  | 'currency'
  | 'rating'
  | 'file'
  | 'user_ref'
  | 'entity_ref';

export interface CustomFieldDefinition {
  id: string;
  slug: string;
  name: string;
  fieldType: CustomFieldType;
  options: { label: string; value: string; color?: string }[];
  required: boolean;
}

export interface StatusOption {
  value: string;
  label: string;
  color?: string;
}

// ============================================================================
// Wire shapes (internal)
// ============================================================================

interface ListEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface DataEnvelope<T> {
  data: T;
}

interface AddressRow {
  line1?: string | null;
  line2?: string | null;
  street?: string | null;
  houseNumber?: string | null;
  postalCode?: string | null;
  city?: string | null;
  state?: string | null;
  province?: string | null;
  country?: string | null;
}

interface PersonRow {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  displayName?: string | null;
  title?: string | null;
  department?: string | null;
  email?: string | null;
  directPhone?: string | null;
  mobilePhone?: string | null;
  status?: string | null;
  lifecycleStage?: string | null;
  ownerId?: string | null;
  accountManagerId?: string | null;
  tags?: string[] | null;
  preferredLanguage?: string | null;
  linkedinUrl?: string | null;
  primaryAddress?: AddressRow | null;
  isLead?: boolean | null;
  isSupplier?: boolean | null;
  notes?: string | null;
  customFields?: CustomFieldValues | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CompanyRow {
  id: string;
  name: string;
  displayName?: string | null;
  industry?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  description?: string | null;
  status?: string | null;
  lifecycleStage?: string | null;
  ownerId?: string | null;
  accountManagerId?: string | null;
  tags?: string[] | null;
  vatNumber?: string | null;
  registrationNumber?: string | null;
  employeeCount?: string | number | null;
  preferredLanguage?: string | null;
  primaryAddress?: AddressRow | null;
  isLead?: boolean | null;
  isSupplier?: boolean | null;
  customFields?: CustomFieldValues | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PersonCompanyRow {
  id: string;
  companyId: string;
  role?: string | null;
  isPrimary: boolean;
  company: { id: string; displayName: string; name?: string | null; industry?: string | null };
}

interface CompanyPersonRow {
  id: string;
  personId: string;
  role?: string | null;
  isPrimary: boolean;
  person: { id: string; displayName: string; email?: string | null };
}

interface ActivityRow {
  id: string;
  type: string;
  subject: string;
  description?: string | null;
  status?: string | null;
  customerId?: string | null;
  contactId?: string | null;
  personId?: string | null;
  relatedTo?: string | null;
  relatedToId?: string | null;
  relatedToName?: string | null;
  assignedToId?: string | null;
  createdAt: string;
}

interface PipelineRow {
  id: string;
  name: string;
  color?: string | null;
}

interface PipelineStageRow {
  id: string;
  name: string;
  color?: string | null;
  position: number;
  probability?: number | null;
  isWon?: boolean | null;
  isLost?: boolean | null;
  /** Stores the owning pipeline's id ('default' for the legacy default pipeline). */
  pipeline?: string | null;
}

interface OpportunityRow {
  id: string;
  name: string;
  amount?: string | null;
  currency?: string | null;
  stageId?: string | null;
  pipeline?: string | null;
  status?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  primaryContactId?: string | null;
  closeDate?: string | null;
  actualCloseDate?: string | null;
  probability?: number | null;
  description?: string | null;
  ownerId?: string | null;
  leadSource?: string | null;
  type?: string | null;
  nextStep?: string | null;
  tags?: string[] | null;
  customFields?: CustomFieldValues | null;
  createdAt: string;
  updatedAt: string;
}

interface MemberRow {
  id: string;
  userId?: string | null;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
}

interface CustomFieldRow {
  id: string;
  slug: string;
  name: string;
  fieldType: string;
  options?: { label: string; value: string; color?: string }[] | null;
  required?: boolean | null;
}

interface CustomerStatusRow {
  slug: string;
  name: string;
  color?: string | null;
  sortOrder: number;
}

interface WorkspaceSettingsRow {
  currency?: string | null;
}

// ============================================================================
// Adapters
// ============================================================================

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function fail<T>(err: unknown): ApiResponse<T> {
  return { success: false, error: err instanceof Error ? err.message : 'Request failed' };
}

function toPage<T, R>(res: ListEnvelope<R>, map: (row: R) => T): Page<T> {
  return {
    items: res.data.map(map),
    totalCount: res.pagination.totalCount,
    hasMore: res.pagination.hasMore,
    cursor: res.pagination.cursor,
  };
}

/** Build `?a=1&b=2`, leaving out empty values. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.append(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

const optional = (value: string | null | undefined) => value || undefined;

/** The person a 409 "email already in the CRM" points at, from the error body's details. */
export function existingPersonIdOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || (err as { status?: number }).status !== 409) return undefined;
  const body = (err as { body?: unknown }).body as
    | { details?: { existingPersonId?: unknown }; error?: { details?: { existingPersonId?: unknown } } }
    | undefined;
  const id = body?.details?.existingPersonId ?? body?.error?.details?.existingPersonId;
  return typeof id === 'string' ? id : undefined;
}

export function mapAddress(row: AddressRow | null | undefined): Address | undefined {
  if (!row) return undefined;
  const line1 = row.line1 || [row.street, row.houseNumber].filter(Boolean).join(' ') || undefined;
  const address: Address = {
    line1,
    line2: optional(row.line2),
    postalCode: optional(row.postalCode),
    city: optional(row.city),
    state: optional(row.state || row.province),
    country: optional(row.country),
  };
  return Object.values(address).some(Boolean) ? address : undefined;
}

/** "Street 1, 1234 AB City, NL" for display. */
export function formatAddress(address: Address | undefined): string {
  if (!address) return '';
  const cityLine = [address.postalCode, address.city].filter(Boolean).join(' ');
  return [address.line1, address.line2, cityLine, address.state, address.country].filter(Boolean).join(', ');
}

function mapPerson(row: PersonRow): PersonRecord {
  return {
    id: row.id,
    name: resolveName(row),
    firstName: optional(row.firstName),
    lastName: optional(row.lastName),
    jobTitle: optional(row.title),
    department: optional(row.department),
    email: row.email ?? '',
    phone: optional(row.directPhone),
    mobile: optional(row.mobilePhone),
    status: optional(row.status),
    lifecycleStage: optional(row.lifecycleStage),
    ownerId: optional(row.ownerId),
    accountManagerId: optional(row.accountManagerId),
    tags: row.tags ?? [],
    language: optional(row.preferredLanguage),
    linkedinUrl: optional(row.linkedinUrl),
    address: mapAddress(row.primaryAddress),
    isLead: !!row.isLead,
    isSupplier: !!row.isSupplier,
    notes: optional(row.notes),
    customFields: row.customFields ?? {},
    archivedAt: optional(row.archivedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapCompany(row: CompanyRow): CompanyRecord {
  return {
    id: row.id,
    name: resolveName(row),
    industry: optional(row.industry),
    website: optional(row.website),
    email: row.email ?? '',
    phone: optional(row.phone),
    mobile: optional(row.mobile),
    description: optional(row.description),
    status: optional(row.status),
    lifecycleStage: optional(row.lifecycleStage),
    ownerId: optional(row.ownerId),
    accountManagerId: optional(row.accountManagerId),
    tags: row.tags ?? [],
    vatNumber: optional(row.vatNumber),
    registrationNumber: optional(row.registrationNumber),
    employeeCount: row.employeeCount === null || row.employeeCount === undefined ? undefined : String(row.employeeCount),
    language: optional(row.preferredLanguage),
    address: mapAddress(row.primaryAddress),
    isLead: !!row.isLead,
    isSupplier: !!row.isSupplier,
    customFields: row.customFields ?? {},
    archivedAt: optional(row.archivedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapDeal(row: OpportunityRow): DealRecord {
  return {
    id: row.id,
    name: row.name,
    value: row.amount ?? undefined,
    currency: optional(row.currency),
    stageId: optional(row.stageId),
    pipelineId: optional(row.pipeline),
    status: row.status || 'open',
    companyId: optional(row.customerId),
    companyName: optional(row.customerName),
    primaryContactId: optional(row.primaryContactId),
    expectedCloseDate: optional(row.closeDate),
    actualCloseDate: optional(row.actualCloseDate),
    probability: row.probability ?? undefined,
    description: optional(row.description),
    ownerId: optional(row.ownerId),
    leadSource: optional(row.leadSource),
    type: optional(row.type),
    nextStep: optional(row.nextStep),
    tags: row.tags ?? [],
    customFields: row.customFields ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapActivity(row: ActivityRow): CrmActivity {
  return {
    id: row.id,
    type: row.type,
    subject: row.subject,
    description: optional(row.description),
    status: optional(row.status),
    record: recordOfActivity(row),
    assignedToId: optional(row.assignedToId),
    createdAt: row.createdAt,
  };
}

function mapStage(row: PipelineStageRow, pipelineId: string): PipelineStage {
  return {
    id: row.id,
    name: row.name,
    color: optional(row.color),
    position: row.position,
    pipelineId: row.pipeline ?? pipelineId,
    probability: row.probability ?? undefined,
    isWon: !!row.isWon,
    isLost: !!row.isLost,
  };
}

const KNOWN_FIELD_TYPES = new Set<string>([
  'text', 'textarea', 'number', 'date', 'single_select', 'multi_select', 'boolean',
  'url', 'email', 'phone', 'currency', 'rating', 'file', 'user_ref', 'entity_ref',
]);

/** Won deals are read in pages of 100; this caps a dashboard load at 1,000 of them. */
const WON_DEALS_PAGE_LIMIT = 100;
const WON_DEALS_MAX_PAGES = 10;

/**
 * Per-workspace caches (currency, members, custom fields, statuses), keyed by
 * workspace id so switching workspace, or signing in as someone else, never
 * reuses another workspace's.
 */
const workspaceCurrencyCache = new Map<string, string>();
const membersCache = new Map<string, Member[]>();
let activeWorkspaceId: string | null = null;

/**
 * Tell the data layer which workspace is active (the Clerk organization id), or
 * null when signed out. Wired from `app/_layout.tsx`, like the token getter.
 */
export function setActiveWorkspaceId(workspaceId: string | null) {
  activeWorkspaceId = workspaceId;
}

// ============================================================================
// Payload builders
// ============================================================================

const trimmed = (value: string | undefined) => (value === undefined ? undefined : value.trim());

/** Address for the API: `null` clears, an all-empty address clears too. */
function addressPayload(address: Address | null | undefined): AddressRow | null | undefined {
  if (address === undefined) return undefined;
  if (address === null) return null;
  const row: AddressRow = {
    line1: trimmed(address.line1) || undefined,
    line2: trimmed(address.line2) || undefined,
    postalCode: trimmed(address.postalCode) || undefined,
    city: trimmed(address.city) || undefined,
    state: trimmed(address.state) || undefined,
    country: trimmed(address.country) || undefined,
  };
  return Object.values(row).some(Boolean) ? row : null;
}

function assign(payload: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) payload[key] = value;
}

/** Request body for a person create or update; fields that weren't given are left out. */
export function personPayload(input: PersonInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  assign(payload, 'firstName', trimmed(input.firstName));
  assign(payload, 'lastName', trimmed(input.lastName));
  assign(payload, 'title', trimmed(input.jobTitle));
  assign(payload, 'department', trimmed(input.department));
  assign(payload, 'email', trimmed(input.email));
  assign(payload, 'directPhone', trimmed(input.phone));
  assign(payload, 'mobilePhone', trimmed(input.mobile));
  assign(payload, 'notes', input.notes);
  assign(payload, 'status', input.status);
  assign(payload, 'lifecycleStage', input.lifecycleStage);
  assign(payload, 'ownerId', input.ownerId);
  assign(payload, 'accountManagerId', input.accountManagerId);
  assign(payload, 'tags', input.tags);
  assign(payload, 'preferredLanguage', input.language);
  assign(payload, 'linkedinUrl', trimmed(input.linkedinUrl));
  assign(payload, 'primaryAddress', addressPayload(input.address));
  assign(payload, 'isLead', input.isLead);
  assign(payload, 'isSupplier', input.isSupplier);
  assign(payload, 'customFields', input.customFields);
  if (input.companyId) {
    payload.companyIds = [input.companyId];
    payload.primaryCompanyId = input.companyId;
  }
  return payload;
}

/** Request body for a company create or update; fields that weren't given are left out. */
export function companyPayload(input: CompanyInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  assign(payload, 'name', trimmed(input.name));
  assign(payload, 'industry', trimmed(input.industry));
  assign(payload, 'website', trimmed(input.website));
  assign(payload, 'email', trimmed(input.email));
  assign(payload, 'phone', trimmed(input.phone));
  assign(payload, 'mobile', trimmed(input.mobile));
  assign(payload, 'description', input.description);
  assign(payload, 'status', input.status);
  assign(payload, 'lifecycleStage', input.lifecycleStage);
  assign(payload, 'ownerId', input.ownerId);
  assign(payload, 'accountManagerId', input.accountManagerId);
  assign(payload, 'tags', input.tags);
  assign(payload, 'vatNumber', trimmed(input.vatNumber));
  assign(payload, 'registrationNumber', trimmed(input.registrationNumber));
  assign(payload, 'employeeCount', trimmed(input.employeeCount));
  assign(payload, 'preferredLanguage', input.language);
  assign(payload, 'primaryAddress', addressPayload(input.address));
  assign(payload, 'isLead', input.isLead);
  assign(payload, 'isSupplier', input.isSupplier);
  assign(payload, 'customFields', input.customFields);
  return payload;
}

/** Request body for a deal update; `closeDate: null` clears it. */
export function dealUpdatePayload(input: DealUpdate): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  assign(payload, 'name', trimmed(input.name));
  assign(payload, 'amount', input.amount);
  assign(payload, 'currency', input.currency);
  if (input.stageId !== undefined) {
    // The board writes the legacy `stage` column with the stage id too.
    payload.stageId = input.stageId;
    payload.stage = input.stageId;
  }
  assign(payload, 'status', input.status);
  assign(payload, 'probability', input.probability);
  assign(payload, 'closeDate', input.closeDate);
  assign(payload, 'description', input.description);
  assign(payload, 'ownerId', input.ownerId);
  assign(payload, 'leadSource', trimmed(input.leadSource));
  assign(payload, 'type', trimmed(input.type));
  assign(payload, 'nextStep', trimmed(input.nextStep));
  assign(payload, 'tags', input.tags);
  assign(payload, 'customFields', input.customFields);
  assign(payload, 'customerId', input.companyId);
  assign(payload, 'primaryContactId', input.primaryContactId);
  return payload;
}

// ============================================================================
// API client
// ============================================================================

const api = {
  // ========== Workspace ==========
  /**
   * The workspace's default currency (Settings > General). A workspace that
   * never saved one uses EUR, which is also what a deal without a currency is.
   */
  async getWorkspaceCurrency(): Promise<string> {
    const workspaceId = activeWorkspaceId;
    const cached = workspaceId ? workspaceCurrencyCache.get(workspaceId) : undefined;
    if (cached) return cached;
    try {
      const res = await appApiClient.get<DataEnvelope<WorkspaceSettingsRow | null>>('/workspace-settings');
      const currency = resolveCurrency(res.data?.currency);
      // Not kept when there is no workspace yet, or it changed while this was loading.
      if (workspaceId && workspaceId === activeWorkspaceId) workspaceCurrencyCache.set(workspaceId, currency);
      return currency;
    } catch {
      return DEFAULT_CURRENCY;
    }
  },

  /** Everyone in the workspace (all pages), for owner / manager / assignee pickers. */
  async getMembers(): Promise<ApiResponse<Member[]>> {
    const workspaceId = activeWorkspaceId;
    const cached = workspaceId ? membersCache.get(workspaceId) : undefined;
    if (cached) return ok(cached);
    try {
      const members: Member[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const res: ListEnvelope<MemberRow> = await appApiClient.get<ListEnvelope<MemberRow>>(
          `/team-members${query({ memberType: 'all', limit: 100, cursor })}`,
        );
        for (const row of res.data) {
          if (!row.userId) continue;
          members.push({
            userId: row.userId,
            name: row.name || row.email || row.userId,
            email: optional(row.email),
            avatarUrl: optional(row.picture),
          });
        }
        cursor = res.pagination.cursor;
        if (!res.pagination.hasMore || !cursor) break;
      }
      if (workspaceId && workspaceId === activeWorkspaceId) membersCache.set(workspaceId, members);
      return ok(members);
    } catch (err) {
      return fail(err);
    }
  },

  async getCustomFields(entityType: 'company' | 'person' | 'opportunity'): Promise<ApiResponse<CustomFieldDefinition[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<CustomFieldRow[]>>(`/custom-fields${query({ entityType })}`);
      return ok(
        res.data
          .filter((row) => KNOWN_FIELD_TYPES.has(row.fieldType))
          .map((row) => ({
            id: row.id,
            slug: row.slug,
            name: row.name,
            fieldType: row.fieldType as CustomFieldType,
            options: row.options ?? [],
            required: !!row.required,
          })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  /** The workspace's own customer statuses (Settings > WeldCRM), in their order. */
  async getCustomerStatuses(): Promise<ApiResponse<StatusOption[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<CustomerStatusRow[]>>('/customer-statuses');
      return ok(
        [...res.data]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((row) => ({ value: row.slug, label: row.name, color: optional(row.color) })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Dashboard ==========
  /**
   * The API has no CRM stats endpoint, so the counters come from the list
   * endpoints' totals. Revenue adds up the won deals that are in the workspace
   * currency, across every page up to 1,000 deals; deals in other currencies
   * are counted in `revenueExcluded` and never converted or added.
   */
  async getCrmDashboardStats(): Promise<ApiResponse<CrmDashboardStats>> {
    try {
      const [people, companies, leadPeople, leadCompanies, openDeals, currency] = await Promise.all([
        appApiClient.get<ListEnvelope<unknown>>('/people?limit=1&inCrm=true'),
        appApiClient.get<ListEnvelope<unknown>>('/companies?limit=1'),
        appApiClient.get<ListEnvelope<unknown>>('/people?limit=1&inCrm=true&isLead=true'),
        appApiClient.get<ListEnvelope<unknown>>('/companies?limit=1&isLead=true'),
        appApiClient.get<ListEnvelope<unknown>>('/opportunities?limit=1&status=open'),
        api.getWorkspaceCurrency(),
      ]);

      const wonDeals: OpportunityRow[] = [];
      let wonTotalCount = 0;
      let cursor: string | null = null;
      let revenuePartial = false;
      for (let pageIndex = 0; pageIndex < WON_DEALS_MAX_PAGES; pageIndex += 1) {
        const res: ListEnvelope<OpportunityRow> = await appApiClient.get<ListEnvelope<OpportunityRow>>(
          `/opportunities${query({ status: 'won', limit: WON_DEALS_PAGE_LIMIT, cursor })}`,
        );
        wonDeals.push(...res.data);
        wonTotalCount = res.pagination.totalCount;
        cursor = res.pagination.cursor;
        if (!res.pagination.hasMore || !cursor) break;
        if (pageIndex === WON_DEALS_MAX_PAGES - 1) revenuePartial = true;
      }

      const revenue = sumInCurrency(
        wonDeals.map((deal) => ({ amount: deal.amount, currency: deal.currency })),
        currency,
      );
      return ok({
        totalPeople: people.pagination.totalCount,
        totalCompanies: companies.pagination.totalCount,
        leads: leadPeople.pagination.totalCount + leadCompanies.pagination.totalCount,
        openDeals: openDeals.pagination.totalCount,
        wonDeals: wonTotalCount,
        revenue: revenue.total,
        currency,
        revenueExcluded: revenue.excluded,
        revenuePartial,
        revenueDealsRead: wonDeals.length,
      });
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Activities (timeline) ==========
  /** Latest activities, all records or one record's (the web's Activity tab). */
  async getActivities(params?: {
    record?: Pick<RecordRef, 'kind' | 'id'>;
    opportunityId?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<ApiResponse<Page<CrmActivity>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<ActivityRow>>(
        `/activities${query({
          limit: params?.limit ?? 25,
          cursor: params?.cursor,
          customerId: params?.record?.kind === 'company' ? params.record.id : undefined,
          // `personId` matches both person columns, like the person timeline on the web.
          personId: params?.record?.kind === 'person' ? params.record.id : undefined,
          opportunityId: params?.opportunityId,
        })}`,
      );
      return ok(toPage(res, mapActivity));
    } catch (err) {
      return fail(err);
    }
  },

  async logActivity(input: ActivityInput): Promise<ApiResponse<{ id: string }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/activities', {
        type: input.type,
        subject: input.subject.trim(),
        description: input.description,
        status: 'completed',
        opportunityId: input.opportunityId,
        ...recordLinkPayload(input.record),
      });
      return ok({ id: res.data.id });
    } catch (err) {
      return fail(err);
    }
  },

  // ========== People ==========
  async getPeople(params?: {
    cursor?: string | null;
    limit?: number;
    search?: string;
    companyId?: string;
    isLead?: boolean;
    isSupplier?: boolean;
  }): Promise<ApiResponse<Page<PersonRecord>>> {
    try {
      // `inCrm=true` is what the platform's People grid passes: it leaves out
      // identities that only exist because they emailed or chatted with you.
      // Boolean filters are only ever sent as `true` (the API coerces "false" to true).
      const res = await appApiClient.get<ListEnvelope<PersonRow>>(
        `/people${query({
          limit: params?.limit ?? 25,
          cursor: params?.cursor,
          search: params?.search?.trim(),
          companyId: params?.companyId,
          isLead: params?.isLead ? true : undefined,
          isSupplier: params?.isSupplier ? true : undefined,
          inCrm: true,
        })}`,
      );
      return ok(toPage(res, mapPerson));
    } catch (err) {
      return fail(err);
    }
  },

  async getPerson(id: string): Promise<ApiResponse<PersonRecord>> {
    try {
      const res = await appApiClient.get<DataEnvelope<PersonRow>>(`/people/${id}`);
      return ok(mapPerson(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async getPersonCompanies(id: string): Promise<ApiResponse<PersonCompany[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<PersonCompanyRow[]>>(`/people/${id}/companies`);
      return ok(
        res.data.map((row) => ({
          linkId: row.id,
          companyId: row.companyId,
          name: row.company.displayName || row.company.name || '',
          industry: row.company.industry ?? undefined,
          role: row.role ?? undefined,
          isPrimary: row.isPrimary,
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  /** Fails with `existingPersonId` set when someone in the CRM already has this email. */
  async createPerson(input: PersonInput): Promise<ApiResponse<{ id: string }> & { existingPersonId?: string }> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/people', personPayload(input));
      return ok({ id: res.data.id });
    } catch (err) {
      return { ...fail<{ id: string }>(err), existingPersonId: existingPersonIdOf(err) };
    }
  },

  async updatePerson(id: string, input: PersonInput): Promise<ApiResponse<PersonRecord>> {
    try {
      const res = await appApiClient.patch<DataEnvelope<PersonRow>>(`/people/${id}`, personPayload(input));
      return ok(mapPerson(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async setPersonArchived(id: string, archived: boolean): Promise<ApiResponse<PersonRecord>> {
    try {
      const res = await appApiClient.post<DataEnvelope<PersonRow>>(
        `/people/${id}/${archived ? 'archive' : 'unarchive'}`,
        {},
      );
      return ok(mapPerson(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async deletePerson(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/people/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Companies ==========
  async getCompanies(params?: {
    cursor?: string | null;
    limit?: number;
    search?: string;
    isLead?: boolean;
    isSupplier?: boolean;
  }): Promise<ApiResponse<Page<CompanyRecord>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<CompanyRow>>(
        `/companies${query({
          limit: params?.limit ?? 25,
          cursor: params?.cursor,
          search: params?.search?.trim(),
          isLead: params?.isLead ? true : undefined,
          isSupplier: params?.isSupplier ? true : undefined,
        })}`,
      );
      return ok(toPage(res, mapCompany));
    } catch (err) {
      return fail(err);
    }
  },

  async getCompany(id: string): Promise<ApiResponse<CompanyRecord>> {
    try {
      const res = await appApiClient.get<DataEnvelope<CompanyRow>>(`/companies/${id}`);
      return ok(mapCompany(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async getCompanyPeople(id: string): Promise<ApiResponse<CompanyPerson[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<CompanyPersonRow[]>>(`/companies/${id}/people`);
      return ok(
        res.data.map((row) => ({
          linkId: row.id,
          personId: row.personId,
          name: row.person.displayName,
          email: row.person.email ?? undefined,
          role: row.role ?? undefined,
          isPrimary: row.isPrimary,
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  async getCompanyDeals(id: string): Promise<ApiResponse<DealRecord[]>> {
    try {
      const res = await appApiClient.get<ListEnvelope<OpportunityRow>>(
        `/opportunities${query({ customerId: id, limit: 100 })}`,
      );
      return ok(res.data.map(mapDeal));
    } catch (err) {
      return fail(err);
    }
  },

  async getPersonDeals(id: string): Promise<ApiResponse<DealRecord[]>> {
    try {
      const res = await appApiClient.get<ListEnvelope<OpportunityRow>>(
        `/opportunities${query({ personId: id, limit: 100 })}`,
      );
      return ok(res.data.map(mapDeal));
    } catch (err) {
      return fail(err);
    }
  },

  async createCompany(input: CompanyInput): Promise<ApiResponse<{ id: string }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/companies', companyPayload(input));
      return ok({ id: res.data.id });
    } catch (err) {
      return fail(err);
    }
  },

  async updateCompany(id: string, input: CompanyInput): Promise<ApiResponse<CompanyRecord>> {
    try {
      const res = await appApiClient.patch<DataEnvelope<CompanyRow>>(`/companies/${id}`, companyPayload(input));
      return ok(mapCompany(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async setCompanyArchived(id: string, archived: boolean): Promise<ApiResponse<CompanyRecord>> {
    try {
      const res = await appApiClient.post<DataEnvelope<CompanyRow>>(
        `/companies/${id}/${archived ? 'archive' : 'unarchive'}`,
        {},
      );
      return ok(mapCompany(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async deleteCompany(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/companies/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Person ↔ company links ==========
  async linkPersonToCompany(input: {
    personId: string;
    companyId: string;
    role?: string;
    isPrimary?: boolean;
  }): Promise<ApiResponse<null>> {
    try {
      await appApiClient.post('/person-companies', {
        personId: input.personId,
        companyId: input.companyId,
        role: input.role?.trim() || undefined,
        isPrimary: input.isPrimary ?? false,
      });
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  async unlinkPersonFromCompany(linkId: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/person-companies/${linkId}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  async setPrimaryCompanyLink(linkId: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.patch(`/person-companies/${linkId}`, { isPrimary: true });
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Pipelines & deals ==========
  async getPipelines(): Promise<ApiResponse<PipelineWithStages[]>> {
    try {
      const pipelinesRes = await appApiClient.get<ListEnvelope<PipelineRow>>('/pipelines?limit=100');
      // Stages per pipeline: one global page could leave a pipeline's stages out.
      const stagePages = await Promise.all(
        pipelinesRes.data.map((pipeline) =>
          appApiClient.get<ListEnvelope<PipelineStageRow>>(
            `/pipeline-stages${query({ pipeline: pipeline.id, limit: 200 })}`,
          ),
        ),
      );
      return ok(
        pipelinesRes.data.map((pipeline, index) => ({
          id: pipeline.id,
          name: pipeline.name,
          color: optional(pipeline.color),
          stages: stagePages[index].data
            .filter((stage) => (stage.pipeline ?? pipeline.id) === pipeline.id)
            .sort((a, b) => a.position - b.position)
            .map((stage) => mapStage(stage, pipeline.id)),
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  async getDeals(params?: {
    cursor?: string | null;
    limit?: number;
    search?: string;
    pipelineId?: string;
  }): Promise<ApiResponse<Page<DealRecord>>> {
    try {
      // The server filters by `pipeline` (id); stage filtering happens on the
      // board, which already groups deals by stage.
      const res = await appApiClient.get<ListEnvelope<OpportunityRow>>(
        `/opportunities${query({
          limit: params?.limit ?? 100,
          cursor: params?.cursor,
          search: params?.search?.trim(),
          pipeline: params?.pipelineId,
        })}`,
      );
      return ok(toPage(res, mapDeal));
    } catch (err) {
      return fail(err);
    }
  },

  async getDeal(id: string): Promise<ApiResponse<DealRecord>> {
    try {
      const res = await appApiClient.get<DataEnvelope<OpportunityRow>>(`/opportunities/${id}`);
      return ok(mapDeal(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async createDeal(data: DealInput): Promise<ApiResponse<DealRecord>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/opportunities', {
        name: data.name.trim(),
        customerId: data.companyId,
        amount: data.amount,
        currency: data.currency,
        stageId: data.stageId,
        stage: data.stageId,
        probability: data.probability,
        closeDate: data.closeDate,
        description: data.notes,
        pipeline: data.pipelineId,
        primaryContactId: data.primaryContactId,
      });
      const now = new Date().toISOString();
      // Create returns { id }: build the record for local state.
      return ok({
        id: res.data.id,
        name: data.name.trim(),
        value: data.amount === undefined ? undefined : String(toNumber(data.amount)),
        currency: data.currency,
        stageId: data.stageId,
        pipelineId: data.pipelineId,
        status: 'open',
        companyId: data.companyId,
        primaryContactId: data.primaryContactId,
        expectedCloseDate: data.closeDate,
        probability: data.probability,
        description: data.notes,
        tags: [],
        customFields: {},
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      return fail(err);
    }
  },

  /**
   * Save a deal and read it back: the server moves a won/lost deal to its
   * pipeline's won/lost stage (and a stage move can change the status), so
   * the screen shows what was actually stored.
   */
  async updateDeal(id: string, input: DealUpdate): Promise<ApiResponse<DealRecord>> {
    try {
      await appApiClient.patch(`/opportunities/${id}`, dealUpdatePayload(input));
      const res = await appApiClient.get<DataEnvelope<OpportunityRow>>(`/opportunities/${id}`);
      return ok(mapDeal(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async deleteDeal(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/opportunities/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },
};

export { api };
export default api;
