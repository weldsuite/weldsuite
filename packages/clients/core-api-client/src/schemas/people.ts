import { z } from 'zod';

// ============================================================================
// People — identity layer for individuals.
//
// Includes individual customers (formerly b2c parties), employees of
// companies (formerly `contacts`), and anonymous helpdesk visitors that
// later resolved to a real identity. Employment history at companies lives
// in `person_companies`. GDPR-relevant consent flags live here (the person
// owns those, not the commercial relationship).
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

export const createPersonSchema = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  fullName: z.string().max(255).optional(),

  dateOfBirth: z.string().datetime().optional(),
  gender: z.string().max(20).optional(),

  // Professional (authoritative copy lives in person_companies)
  title: z.string().max(100).optional(),
  department: z.string().max(100).optional(),
  role: z.string().max(30).optional(),

  // Contact info
  email: z.string().email().optional().or(z.literal('')),
  alternateEmails: z.array(z.string().email()).optional(),
  directPhone: z.string().max(50).optional(),
  mobilePhone: z.string().max(50).optional(),
  extension: z.string().max(20).optional(),

  // Addresses
  primaryAddress: addressSchema.optional(),
  addresses: z.array(addressSchema).optional(),

  // Visual
  avatarUrl: z.string().max(1000).optional(),
  linkedinUrl: z.string().max(500).optional(),
  twitterHandle: z.string().max(100).optional(),

  // Sales
  ownerId: z.string().nullish(),
  accountManagerId: z.string().nullish(),

  // Lifecycle
  status: z.string().optional(),
  lifecycleStage: z.string().optional(),
  rating: z.string().optional(),
  source: z.string().optional(),

  // Status flags
  isSupplier: z.boolean().optional(),
  isLead: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
  /**
   * CRM membership. Omitted → DB default `true` (people created via the CRM
   * are CRM members). Email-guest resolvers pass `false` to keep mail-only
   * identities out of the CRM grid.
   */
  inCrm: z.boolean().optional(),

  // Influence
  isDecisionMaker: z.boolean().optional(),
  isBillingContact: z.boolean().optional(),
  isTechnicalContact: z.boolean().optional(),
  influenceLevel: z.string().optional(),

  // Preferences
  preferredContactMethod: z.string().optional(),
  preferredLanguage: z.string().optional(),
  bestTimeToContact: z.string().optional(),

  // Marketing
  marketingConsent: z.boolean().optional(),
  emailOptIn: z.boolean().optional(),
  smsOptIn: z.boolean().optional(),
  doNotCall: z.boolean().optional(),

  tags: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
  customFields: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),

  // Optional employment at create time — creates a person_companies row.
  companyIds: z.array(z.string()).optional(),
  primaryCompanyId: z.string().nullish(),
});

export const updatePersonSchema = createPersonSchema.partial().extend({
  ifVersion: z.number().int().positive().optional(),
});

export const listPeopleQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.string().optional(),
  ownerId: z.string().optional(),
  isSupplier: z.coerce.boolean().optional(),
  isLead: z.coerce.boolean().optional(),
  companyId: z.string().optional(),
  /** Restrict to people that are members of the given list (kind='person'). */
  listId: z.string().optional(),
  /**
   * Restrict by CRM membership. The WeldCRM People grid passes `true` so it
   * only shows real CRM contacts; mail surfaces omit it to see every identity.
   */
  inCrm: z.coerce.boolean().optional(),
});

export const personDetailQuery = z.object({
  activitiesLimit: z.coerce.number().min(1).max(50).default(10),
  ticketsLimit: z.coerce.number().min(1).max(50).default(10),
  companiesLimit: z.coerce.number().min(1).max(50).default(20),
});

export const personNavigationQuery = z.object({
  listId: z.string().optional(),
});

export const bulkUpdatePeopleSchema = z.object({
  personIds: z.array(z.string()).min(1).max(500),
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
// Import is an upsert: each record is matched against an existing person by
// `partyCode` first (the tenant-unique import key) and then by `email`.
// Matches are patched; the rest are created. People are imported standalone —
// any company column is ignored (no person_companies linking here).
//
// The record schema is intentionally lenient (plain strings, no `.email()` /
// `.datetime()`): import data is messy, and a single malformed cell must not
// reject the whole batch at validation time. The service collects per-row
// problems instead. Unknown columns are stripped.
//
// Export reuses the list filters (minus pagination) and returns every matching
// row; the client turns the rows into CSV/XLSX.
// ============================================================================

export const importPersonRecordSchema = z.object({
  partyCode: z.string().max(50).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  fullName: z.string().max(255).optional(),
  // Lenient string — the service parses it via `new Date(...)`.
  dateOfBirth: z.string().optional(),
  gender: z.string().max(20).optional(),
  email: z.string().max(255).optional(),
  alternateEmails: z.array(z.string()).optional(),
  directPhone: z.string().max(50).optional(),
  mobilePhone: z.string().max(50).optional(),
  extension: z.string().max(20).optional(),
  title: z.string().max(100).optional(),
  department: z.string().max(100).optional(),
  role: z.string().max(30).optional(),
  status: z.string().max(50).optional(),
  lifecycleStage: z.string().max(50).optional(),
  rating: z.string().max(10).optional(),
  source: z.string().max(100).optional(),
  influenceLevel: z.string().max(10).optional(),
  linkedinUrl: z.string().max(500).optional(),
  twitterHandle: z.string().max(100).optional(),
  preferredContactMethod: z.string().max(20).optional(),
  preferredLanguage: z.string().max(10).optional(),
  bestTimeToContact: z.string().max(100).optional(),
  tags: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
  notes: z.string().max(10000).optional(),
  internalNotes: z.string().max(10000).optional(),
  // User-defined custom fields, keyed by definition slug. Values are
  // already coerced (number/boolean/array) client-side per field type.
  customFields: z.record(z.unknown()).optional(),
});

export const importPeopleSchema = z.object({
  records: z.array(importPersonRecordSchema).min(1).max(500),
});

export const exportPeopleQuery = listPeopleQuery.omit({ cursor: true, limit: true });

export type CreatePersonInput = z.infer<typeof createPersonSchema>;
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;
export type ListPeopleQuery = z.infer<typeof listPeopleQuery>;
export type PersonDetailQuery = z.infer<typeof personDetailQuery>;
export type PersonNavigationQuery = z.infer<typeof personNavigationQuery>;
export type BulkUpdatePeopleInput = z.infer<typeof bulkUpdatePeopleSchema>;
export type ImportPersonRecord = z.infer<typeof importPersonRecordSchema>;
export type ImportPeopleInput = z.infer<typeof importPeopleSchema>;
export type ExportPeopleQuery = z.infer<typeof exportPeopleQuery>;

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

export interface Person {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  archivedAt?: string | null;

  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  /** Server-stamped on every write — canonical name. */
  displayName: string;

  dateOfBirth?: string | null;
  gender?: string | null;

  title?: string | null;
  department?: string | null;
  role?: string | null;

  email?: string | null;
  alternateEmails?: string[] | null;
  directPhone?: string | null;
  mobilePhone?: string | null;
  extension?: string | null;

  primaryAddress?: Record<string, unknown> | null;
  addresses?: Record<string, unknown>[] | null;

  avatarUrl?: string | null;
  linkedinUrl?: string | null;
  twitterHandle?: string | null;

  ownerId?: string | null;
  accountManagerId?: string | null;

  status: string;
  lifecycleStage?: string | null;
  rating?: string | null;
  source?: string | null;

  isSupplier: boolean;
  isLead: boolean;
  isFavorite: boolean;
  /** Whether this person is a member of the CRM (vs a mail-only identity). */
  inCrm: boolean;
  isDecisionMaker?: boolean | null;
  isBillingContact?: boolean | null;
  isTechnicalContact?: boolean | null;
  influenceLevel?: string | null;

  leadScore?: number | null;
  npsScore?: number | null;
  satisfactionScore?: number | null;

  firstContactDate?: string | null;
  lastContactDate?: string | null;
  lastContactedAt?: string | null;
  nextFollowUpDate?: string | null;

  preferredContactMethod?: string | null;
  preferredLanguage?: string | null;
  bestTimeToContact?: string | null;

  marketingConsent?: boolean | null;
  emailOptIn?: boolean | null;
  smsOptIn?: boolean | null;
  doNotCall?: boolean | null;

  tags?: string[] | null;
  interests?: string[] | null;
  customFields?: Record<string, unknown> | null;
  notes?: string | null;
  internalNotes?: string | null;

  partyCode?: string | null;
  visitorId?: string | null;
}
