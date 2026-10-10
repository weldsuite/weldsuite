import { z } from 'zod';

// ============================================================================
// Companies — identity layer for organisations.
//
// After the Companies + People refactor: a Company is an organisation we do
// business with (b2b counterparty, lead, supplier, etc.). "Supplier" /
// "Lead" are status flags on the row, not separate object types.
//
// Commercial / counterparty fields (billing address, payment terms) live on
// the wrapping `parties` row, not here. See `parties.ts` for that surface.
// ============================================================================

/**
 * Canonical lifecycle stages for companies and people (the Details panel's
 * Lifecycle picker, labelled via `crm.*.lifecycleStages`). Only NEW writes are
 * validated against this list, so legacy free-text values already stored on a
 * row stay readable. Keep in sync with `lifecycleStageSchema` in
 * `@weldsuite/core-api-client/schemas/people`.
 */
export const LIFECYCLE_STAGES = [
  'subscriber',
  'lead',
  'marketing_qualified',
  'sales_qualified',
  'opportunity',
  'customer',
  'evangelist',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const lifecycleStageSchema = z.enum(LIFECYCLE_STAGES);

const addressSchema = z
  .object({
    // Shared PostalAddress shape (what `primary_address` stores and the record
    // panel's address editor writes). `street` / `houseNumber` are the older keys.
    line1: z.string().optional(),
    line2: z.string().optional(),
    street: z.string().optional(),
    houseNumber: z.string().optional(),
    postalCode: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    province: z.string().optional(),
    country: z.string().optional(),
  })
  .passthrough();

// ============================================================================
// Validation helpers.
//
// `website` accepts a bare domain ("acme.com") as well as a full URL and
// normalizes it to `https://…`; a non-empty value that still isn't a
// resolvable URL (e.g. "not a url") is rejected rather than silently saved.
// `employeeCount` accepts a plain number or a "11-50" / "10001+" style range
// — free text like "abc" is rejected. Both stay lenient on READ (existing
// stored values aren't re-validated, only new writes go through this schema).
// ============================================================================

function normalizeWebsiteValue(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function isValidWebsiteValue(raw: string): boolean {
  try {
    const url = new URL(normalizeWebsiteValue(raw));
    return url.hostname.includes('.');
  } catch {
    return false;
  }
}

export const websiteSchema = z
  .string()
  .max(500)
  .refine((v) => v === '' || isValidWebsiteValue(v), {
    message: 'Website must be a valid URL (e.g. acme.com or https://acme.com)',
  })
  .transform((v) => (v === '' ? v : normalizeWebsiteValue(v)))
  .optional();

export const employeeCountSchema = z
  .string()
  .max(50)
  .refine((v) => v === '' || /^\d+(-\d+)?\+?$/.test(v), {
    message: 'Employees must be a number or a range (e.g. 42 or 11-50)',
  })
  .optional();

export const createCompanySchema = z.object({
  name: z.string().min(1).max(255),
  tradingName: z.string().max(255).optional(),

  // Legal / registration
  registrationNumber: z.string().max(100).optional(),
  vatNumber: z.string().max(50).optional(),

  // Profile
  industry: z.string().max(100).optional(),
  employeeCount: employeeCountSchema,
  website: websiteSchema,

  // Contact info
  email: z.string().email().optional().or(z.literal('')),
  alternateEmails: z.array(z.string().email()).optional(),
  phone: z.string().max(50).optional(),
  mobile: z.string().max(50).optional(),
  fax: z.string().max(50).optional(),

  // Addresses
  primaryAddress: addressSchema.optional(),
  addresses: z.array(addressSchema).optional(),

  // Visual
  avatarUrl: z.string().max(1000).optional(),
  linkedinUrl: z.string().max(500).optional(),
  twitterHandle: z.string().max(100).optional(),
  facebookUrl: z.string().max(500).optional(),

  // Sales
  ownerId: z.string().nullish(),
  accountManagerId: z.string().nullish(),

  // Lifecycle / classification
  status: z.string().optional(),
  lifecycleStage: lifecycleStageSchema.nullish(),
  segment: z.string().optional(),
  rating: z.string().optional(),
  source: z.string().optional(),

  // Follow-up — lenient strings (grid's date editor sends an ISO string, or
  // null to clear), parsed by the service.
  lastContactDate: z.string().nullish(),
  nextFollowUpDate: z.string().nullish(),

  // Status flags
  isSupplier: z.boolean().optional(),
  isLead: z.boolean().optional(),
  isFavorite: z.boolean().optional(),

  // Preferences
  preferredContactMethod: z.string().optional(),
  preferredLanguage: z.string().optional(),
  timezone: z.string().optional(),

  // Marketing
  marketingConsent: z.boolean().optional(),
  emailOptIn: z.boolean().optional(),
  smsOptIn: z.boolean().optional(),
  doNotCall: z.boolean().optional(),

  // Tags / notes
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
});

export const updateCompanySchema = createCompanySchema.partial().extend({
  // Nullable on update so the record panel's address editor can clear the address.
  primaryAddress: addressSchema.nullish(),
  /**
   * Optimistic concurrency: the `version` the client last saw. When present
   * and it no longer matches the row, the write is rejected with 409 CONFLICT
   * instead of overwriting someone else's change. `version` and `ifVersion`
   * are the same thing; omit both to write unconditionally.
   */
  ifVersion: z.number().int().positive().optional(),
  version: z.number().int().positive().optional(),
});

export const listCompaniesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.string().optional(),
  ownerId: z.string().optional(),
  isSupplier: z.coerce.boolean().optional(),
  isLead: z.coerce.boolean().optional(),
  industry: z.string().optional(),
  /** Restrict to companies that are members of the given list (kind='company'). */
  listId: z.string().optional(),
  /**
   * Sort key. Currently only custom fields are sortable server-side, addressed
   * as `custom:<slug>` (the same key the grid uses for its columns). Built-in
   * columns have never had a server sort; omitting this keeps the historical
   * `createdAt DESC, id DESC` ordering.
   */
  sort: z.string().optional(),
  // Optional rather than .default('asc'): a zod default makes the field
  // REQUIRED on the inferred output type, which would break every existing
  // caller that constructs this query object. The service defaults to 'asc'.
  sortDir: z.enum(['asc', 'desc']).optional(),
  /**
   * Filter on a custom field, as `<slug>:<value>`. Text fields match on
   * case-insensitive substring; number/date/bool/ref match exactly;
   * multi_select matches if it CONTAINS the value.
   */
  customFilter: z.string().optional(),
});

export const companyDetailQuery = z.object({
  activitiesLimit: z.coerce.number().min(1).max(50).default(10),
  ordersLimit: z.coerce.number().min(1).max(50).default(10),
  opportunitiesLimit: z.coerce.number().min(1).max(50).default(10),
  peopleLimit: z.coerce.number().min(1).max(50).default(20),
});

export const companyNavigationQuery = z.object({
  listId: z.string().optional(),
});

export const bulkUpdateCompaniesSchema = z.object({
  companyIds: z.array(z.string()).min(1).max(500),
  updates: z
    .object({
      ownerId: z.string().nullable().optional(),
      accountManagerId: z.string().nullable().optional(),
      status: z.string().optional(),
      lifecycleStage: lifecycleStageSchema.optional(),
    })
    .refine(
      (v) =>
        v.ownerId !== undefined ||
        v.accountManagerId !== undefined ||
        v.status !== undefined ||
        v.lifecycleStage !== undefined,
      { message: 'At least one field must be provided' },
    ),
});

// ============================================================================
// Import / export
//
// Import is an upsert: each record is matched against an existing company by
// `partyCode` first (the human-readable, tenant-unique import key) and then by
// `email`. Matches are patched; the rest are created. `name` is only required
// when a record creates a new company — the service enforces that so a match
// row need not repeat it.
//
// The record schema is intentionally lenient (plain strings, no `.email()` /
// `.datetime()`): import data is messy, and a single malformed cell must not
// reject the whole batch at validation time. The service collects per-row
// problems instead. Unknown columns are stripped.
//
// Export reuses the list filters (minus pagination) and returns every matching
// row; the client turns the rows into CSV/XLSX.
// ============================================================================

export const importCompanyRecordSchema = z.object({
  partyCode: z.string().max(50).optional(),
  name: z.string().max(255).optional(),
  tradingName: z.string().max(255).optional(),
  email: z.string().max(255).optional(),
  alternateEmails: z.array(z.string()).optional(),
  phone: z.string().max(50).optional(),
  mobile: z.string().max(50).optional(),
  fax: z.string().max(50).optional(),
  website: z.string().max(500).optional(),
  // The grid's Primary Address column, so an export re-imports with it mapped.
  primaryAddress: addressSchema.optional(),
  vatNumber: z.string().max(50).optional(),
  registrationNumber: z.string().max(100).optional(),
  industry: z.string().max(100).optional(),
  employeeCount: z.string().max(50).optional(),
  status: z.string().max(50).optional(),
  lifecycleStage: z.string().max(50).optional(),
  segment: z.string().max(50).optional(),
  rating: z.string().max(10).optional(),
  source: z.string().max(100).optional(),
  linkedinUrl: z.string().max(500).optional(),
  twitterHandle: z.string().max(100).optional(),
  facebookUrl: z.string().max(500).optional(),
  preferredContactMethod: z.string().max(20).optional(),
  preferredLanguage: z.string().max(10).optional(),
  timezone: z.string().max(50).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(10000).optional(),
  internalNotes: z.string().max(10000).optional(),
  isSupplier: z.boolean().optional(),
  isLead: z.boolean().optional(),
  // User-defined custom fields, keyed by definition slug. Values are
  // already coerced (number/boolean/array) client-side per field type.
  customFields: z.record(z.unknown()).optional(),
});

/**
 * Per-row checks applied by the import service. They live here (not in
 * `importCompanyRecordSchema`) on purpose: the request-level schema must stay
 * lenient so one bad cell does not reject the whole batch with a 400; the
 * service runs this against each record and reports failures in the per-row
 * error list. It reuses the same website / employeeCount validators as
 * `createCompanySchema`, so import and create accept exactly the same values.
 * Empty cells count as "not provided". Parsed output carries the normalized
 * values (e.g. `acme.com` -> `https://acme.com`).
 */
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const importRecordValidationSchema = z.object({
  email: z.preprocess(
    (v) => (typeof v === 'string' ? emptyToUndefined(v.trim()) : v),
    z.string().email('Email must be a valid email address').optional(),
  ),
  website: z.preprocess((v) => (typeof v === 'string' ? emptyToUndefined(v.trim()) : v), websiteSchema),
  employeeCount: z.preprocess(
    (v) => (typeof v === 'string' ? emptyToUndefined(v.trim()) : v),
    employeeCountSchema,
  ),
  lifecycleStage: z.preprocess(
    (v) => (typeof v === 'string' ? emptyToUndefined(v.trim().toLowerCase().replace(/[\s-]+/g, '_')) : v),
    z
      .enum(LIFECYCLE_STAGES, {
        errorMap: () => ({ message: `Lifecycle stage must be one of: ${LIFECYCLE_STAGES.join(', ')}` }),
      })
      .optional(),
  ),
});

export const importCompaniesSchema = z.object({
  records: z.array(importCompanyRecordSchema).min(1).max(500),
});

export const exportCompaniesQuery = listCompaniesQuery.omit({ cursor: true, limit: true });

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type ListCompaniesQuery = z.infer<typeof listCompaniesQuery>;
export type CompanyDetailQuery = z.infer<typeof companyDetailQuery>;
export type CompanyNavigationQuery = z.infer<typeof companyNavigationQuery>;
export type BulkUpdateCompaniesInput = z.infer<typeof bulkUpdateCompaniesSchema>;
export type ImportCompanyRecord = z.infer<typeof importCompanyRecordSchema>;
export type ImportCompaniesInput = z.infer<typeof importCompaniesSchema>;
export type ExportCompaniesQuery = z.infer<typeof exportCompaniesQuery>;

export interface ImportRowError {
  /** 1-based index of the offending record within the submitted batch. */
  row: number;
  /** Best-effort human reference for the row (partyCode / email / name). */
  ref: string;
  error: string;
}

export interface ImportResult {
  imported: number;
  updated: number;
  failed: number;
  total: number;
  errors: ImportRowError[];
}

export interface Company {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  archivedAt?: string | null;

  name: string;
  tradingName?: string | null;
  /** Server-stamped on every write — canonical name for grids/exports. */
  displayName: string;

  registrationNumber?: string | null;
  vatNumber?: string | null;
  industry?: string | null;
  employeeCount?: string | null;
  website?: string | null;

  email?: string | null;
  alternateEmails?: string[] | null;
  phone?: string | null;
  mobile?: string | null;
  fax?: string | null;

  primaryAddress?: Record<string, unknown> | null;
  addresses?: Record<string, unknown>[] | null;

  avatarUrl?: string | null;
  linkedinUrl?: string | null;
  twitterHandle?: string | null;
  facebookUrl?: string | null;

  ownerId?: string | null;
  accountManagerId?: string | null;

  status: string;
  lifecycleStage?: string | null;
  segment?: string | null;
  rating?: string | null;
  source?: string | null;

  isSupplier: boolean;
  isLead: boolean;
  isFavorite: boolean;

  leadScore?: number | null;
  npsScore?: number | null;
  satisfactionScore?: number | null;

  firstContactDate?: string | null;
  lastContactDate?: string | null;
  nextFollowUpDate?: string | null;

  preferredContactMethod?: string | null;
  preferredLanguage?: string | null;
  timezone?: string | null;

  marketingConsent?: boolean | null;
  emailOptIn?: boolean | null;
  smsOptIn?: boolean | null;
  doNotCall?: boolean | null;

  tags?: string[] | null;
  customFields?: Record<string, unknown> | null;
  notes?: string | null;
  internalNotes?: string | null;

  partyCode?: string | null;
}
