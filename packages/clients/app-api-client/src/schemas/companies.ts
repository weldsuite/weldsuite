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

const addressSchema = z
  .object({
    street: z.string().optional(),
    houseNumber: z.string().optional(),
    postalCode: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    province: z.string().optional(),
    country: z.string().optional(),
  })
  .passthrough();

export const createCompanySchema = z.object({
  name: z.string().min(1).max(255),
  tradingName: z.string().max(255).optional(),

  // Legal / registration
  registrationNumber: z.string().max(100).optional(),
  vatNumber: z.string().max(50).optional(),

  // Profile
  industry: z.string().max(100).optional(),
  employeeCount: z.string().max(50).optional(),
  website: z.string().max(500).optional(),

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
  lifecycleStage: z.string().optional(),
  segment: z.string().optional(),
  rating: z.string().optional(),
  source: z.string().optional(),

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
  ifVersion: z.number().int().positive().optional(),
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
      lifecycleStage: z.string().optional(),
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
  // User-defined custom fields, keyed by definition slug. Values are
  // already coerced (number/boolean/array) client-side per field type.
  customFields: z.record(z.unknown()).optional(),
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
