import { z } from 'zod';

// ============================================================================
// WeldData — lead database (Lemlist-backed).
//
// Shared between the app-api routes (validation) and the platform hooks
// (typed client). Zod v3.
// ============================================================================

// ---------------------------------------------------------------------------
// External database search (proxied server-side to Lemlist)
// ---------------------------------------------------------------------------

/** A single applied filter, e.g. { filterId: 'jobTitle', values: ['CEO'] }. */
export const lemlistFilterSchema = z.object({
  filterId: z.string(),
  values: z.array(z.union([z.string(), z.number()])).default([]),
});

export const searchLeadsSchema = z.object({
  filters: z.array(lemlistFilterSchema).default([]),
  keyword: z.string().optional(),
  page: z.number().int().min(1).default(1),
  size: z.number().int().min(1).max(100).default(25),
  /**
   * WeldData list ids whose already-saved leads should be filtered OUT of the
   * results. The provider can't do this (the lists live in our DB), so it's
   * applied server-side by matching each row's Lemlist id against the leads
   * saved in these lists.
   */
  excludeListIds: z.array(z.string()).max(50).optional(),
});

export type LemlistFilter = z.infer<typeof lemlistFilterSchema>;
export type SearchLeadsInput = z.infer<typeof searchLeadsSchema>;

/** Shape of one option inside a discovered filter. */
export interface LemlistFilterOption {
  value: string;
  label: string;
}

/** Normalised input affordance the platform should render for a filter. */
export type LemlistFilterInputType =
  | 'text'
  | 'number'
  | 'range'
  | 'boolean'
  | 'select'
  | 'multiselect';

/** A discoverable filter definition returned by the database.
 *
 * Lemlist's `/database/filters` endpoint returns `filterId`, `description`,
 * `type` and `helper` — but no display label and (usually) no option list, so
 * `label` is best-effort and the platform humanises it for display. */
export interface LemlistFilterDefinition {
  filterId: string;
  /** Best-effort label. Often just the raw `filterId`; the UI prettifies it. */
  label: string;
  /** Normalised affordance: 'text' | 'number' | 'range' | 'boolean' | 'select' | 'multiselect'. */
  type: LemlistFilterInputType;
  /** Provider description, e.g. "Filter by country". */
  description?: string;
  /** Provider usage hint, e.g. "Use free text search". */
  helper?: string;
  options?: LemlistFilterOption[];
}

export interface LemlistFilterCatalog {
  people: LemlistFilterDefinition[];
  companies: LemlistFilterDefinition[];
}

/** A single search result row (people or companies). Loose by design — the
 * external payload is passed through and the known fields are surfaced. */
export interface LemlistSearchRow {
  id: string;
  kind: 'person' | 'company';
  name?: string | null;
  email?: string | null;
  title?: string | null;
  companyName?: string | null;
  domain?: string | null;
  industry?: string | null;
  location?: string | null;
  country?: string | null;
  companySize?: string | null;
  linkedinUrl?: string | null;
  /** Profile photo (person) or logo (company), when the provider exposes one. */
  avatarUrl?: string | null;
  /** Full original payload. */
  raw: Record<string, unknown>;
}

export interface LemlistSearchResult {
  rows: LemlistSearchRow[];
  page: number;
  size: number;
  total: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// WeldData lists
// ---------------------------------------------------------------------------

export const createWelddataListSchema = z.object({
  name: z.string().min(1).max(255),
  /** A list is typed to one kind; leads of the other kind can't be added. */
  kind: z.enum(['person', 'company']).default('person'),
  description: z.string().max(1000).optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
});

// `kind` is fixed at creation — a list's type can't be flipped underneath its leads.
export const updateWelddataListSchema = createWelddataListSchema.partial().omit({ kind: true });

export const listWelddataListsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  search: z.string().optional(),
});

export type CreateWelddataListInput = z.infer<typeof createWelddataListSchema>;
export type UpdateWelddataListInput = z.infer<typeof updateWelddataListSchema>;
export type ListWelddataListsQuery = z.infer<typeof listWelddataListsQuery>;

export interface WelddataList {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  kind: 'person' | 'company';
  name: string;
  description?: string | null;
  color: string;
  icon: string;
  createdBy?: string | null;
  /** Count of non-deleted leads in the list. */
  leadCount?: number;
}

// ---------------------------------------------------------------------------
// Saved leads
// ---------------------------------------------------------------------------

export const savedLeadInputSchema = z.object({
  kind: z.enum(['person', 'company']),
  lemlistId: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  title: z.string().optional(),
  companyName: z.string().optional(),
  domain: z.string().optional(),
  industry: z.string().optional(),
  location: z.string().optional(),
  country: z.string().optional(),
  companySize: z.string().optional(),
  linkedinUrl: z.string().optional(),
  /** Full external payload snapshot. */
  data: z.record(z.unknown()).optional(),
});

export const addLeadsSchema = z.object({
  leads: z.array(savedLeadInputSchema).min(1).max(200),
});

export const listLeadsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  search: z.string().optional(),
  kind: z.enum(['person', 'company']).optional(),
  convertedStatus: z.enum(['pending', 'converted']).optional(),
});

/** Person leads: optionally create + link the company too (default true). */
export const convertLeadSchema = z.object({
  createCompany: z.boolean().default(true),
});

/**
 * Convert search-result rows straight into CRM, skipping the WeldData list.
 * The rows aren't persisted, so the full lead payload is sent inline (same
 * shape as adding to a list) rather than referenced by id.
 */
export const convertSearchLeadsSchema = z.object({
  leads: z.array(savedLeadInputSchema).min(1).max(200),
  /** For person leads, also find-or-create + link their company (default true). */
  createCompany: z.boolean().default(true),
});

export type SavedLeadInput = z.infer<typeof savedLeadInputSchema>;
export type AddLeadsInput = z.infer<typeof addLeadsSchema>;
export type ListLeadsQuery = z.infer<typeof listLeadsQuery>;
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;
export type ConvertSearchLeadsInput = z.infer<typeof convertSearchLeadsSchema>;

/** Summary of a bulk search-row conversion. */
export interface ConvertSearchLeadsResult {
  /** Number of input rows processed. */
  converted: number;
  /** New CRM people created. */
  people: number;
  /** New CRM companies created (find-or-create dedupes by name). */
  companies: number;
}

/**
 * Convert leads to CRM and add the resulting person/company to an existing CRM
 * list in one step. Accepts inline `leads` (search rows, never persisted) and
 * /or `leadIds` (saved WeldData list leads, which are also marked converted).
 * The CRM list's `kind` decides whether the person or the company id is added.
 */
export const convertToCrmListSchema = z
  .object({
    /** Target CRM list (from `/lists`). */
    listId: z.string().min(1),
    /** Inline search rows. */
    leads: z.array(savedLeadInputSchema).max(200).optional(),
    /** Saved WeldData lead ids. */
    leadIds: z.array(z.string()).max(200).optional(),
    /** For person leads, also find-or-create + link their company (default true). */
    createCompany: z.boolean().default(true),
  })
  .refine((d) => (d.leads?.length ?? 0) + (d.leadIds?.length ?? 0) > 0, {
    message: 'Provide at least one lead',
  });

export type ConvertToCrmListInput = z.infer<typeof convertToCrmListSchema>;

/** Summary of a convert-and-add-to-CRM-list operation. */
export interface ConvertToCrmListResult {
  /** Number of leads processed. */
  converted: number;
  /** New members actually added to the list (already-present ones are skipped). */
  added: number;
}

export interface WelddataLead {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  listId: string;
  addedBy?: string | null;
  kind: 'person' | 'company';
  lemlistId?: string | null;
  data?: Record<string, unknown> | null;
  name?: string | null;
  email?: string | null;
  title?: string | null;
  companyName?: string | null;
  domain?: string | null;
  industry?: string | null;
  location?: string | null;
  country?: string | null;
  companySize?: string | null;
  linkedinUrl?: string | null;
  convertedStatus: 'pending' | 'converted';
  convertedAt?: string | null;
  convertedPersonId?: string | null;
  convertedCompanyId?: string | null;
}

export interface ConvertLeadResult {
  leadId: string;
  personId?: string | null;
  companyId?: string | null;
}

// ---------------------------------------------------------------------------
// Enrichment columns (Clay-style) — pluggable action registry.
//
// Adding a provider (prospeo, hunter, …) is localized:
//   1. add a `<provider>ColumnConfigSchema` and append it to `columnConfigSchema`
//   2. add metadata to `ENRICHMENT_ACTIONS`
//   3. add a runtime handler (apps/web/platform/trigger/welddata/actions/) + a UI form
// The column/cell/run machinery never changes.
// ---------------------------------------------------------------------------

export const ENRICHMENT_ACTION_TYPES = ['ai', 'email_finder', 'phone_finder'] as const;
export type EnrichmentActionType = (typeof ENRICHMENT_ACTION_TYPES)[number];

/** Email-finder providers (data APIs that resolve a work email from name + domain). */
export const EMAIL_FINDER_PROVIDERS = ['findymail', 'prospeo'] as const;
export type EmailFinderProvider = (typeof EMAIL_FINDER_PROVIDERS)[number];

/** Phone-finder sources. `website` extracts a publicly-listed number from the
 * company's own site (from its domain) — no third-party data provider, no
 * stored Google/Places content. Paid providers can be added here later. */
export const PHONE_FINDER_SOURCES = ['website'] as const;
export type PhoneFinderSource = (typeof PHONE_FINDER_SOURCES)[number];

/** AI action — run a prompt template per row, optionally with web search. */
export const aiColumnConfigSchema = z.object({
  type: z.literal('ai'),
  prompt: z.string().min(1).max(8000),
  /** Model id from GET /api/ai-models/models. Omit → provider default. */
  model: z.string().optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
  /** Let the model search the web before answering (grounded research). */
  webSearch: z.boolean().optional(),
});
export type AiColumnConfig = z.infer<typeof aiColumnConfigSchema>;

/** Email-finder action — looks up a verified work email via a data provider.
 * Uses the lead's name + company domain; no prompt. */
export const emailFinderColumnConfigSchema = z.object({
  type: z.literal('email_finder'),
  provider: z.enum(EMAIL_FINDER_PROVIDERS).default('findymail'),
});
export type EmailFinderColumnConfig = z.infer<typeof emailFinderColumnConfigSchema>;

/** Phone-finder action — resolves a publicly-listed business phone number.
 * `website` reads the company's own site (from its domain); no prompt.
 * `webSearchFallback` widens coverage: if the website yields nothing, run a
 * grounded web search (opt-in — uses credits, result flagged unverified). */
export const phoneFinderColumnConfigSchema = z.object({
  type: z.literal('phone_finder'),
  source: z.enum(PHONE_FINDER_SOURCES).default('website'),
  webSearchFallback: z.boolean().optional(),
});
export type PhoneFinderColumnConfig = z.infer<typeof phoneFinderColumnConfigSchema>;

// Future providers append here.
export const columnConfigSchema = z.discriminatedUnion('type', [
  aiColumnConfigSchema,
  emailFinderColumnConfigSchema,
  phoneFinderColumnConfigSchema,
]);
export type ColumnConfig = z.infer<typeof columnConfigSchema>;

/** UI metadata for the action picker. One entry per registered action. */
export interface EnrichmentActionMeta {
  type: EnrichmentActionType;
  label: string;
  description: string;
}
export const ENRICHMENT_ACTIONS: EnrichmentActionMeta[] = [
  { type: 'ai', label: 'AI', description: 'Run an AI prompt against each row (optionally with web search).' },
  { type: 'email_finder', label: 'Email finder', description: 'Find a verified work email from name + company domain.' },
  {
    type: 'phone_finder',
    label: 'Phone finder',
    description: "Find a publicly-listed business phone number from the company's website.",
  },
];

export const createColumnSchema = z.object({
  name: z.string().min(1).max(255),
  config: columnConfigSchema,
});

export const updateColumnSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: columnConfigSchema.optional(),
  sortOrder: z.number().int().optional(),
});

/** Run a column across the list. No leadIds → every lead; onlyMissing skips done cells. */
export const runColumnSchema = z.object({
  leadIds: z.array(z.string()).optional(),
  onlyMissing: z.boolean().optional(),
});

/** Re-run a single cell. */
export const runCellSchema = z.object({
  columnId: z.string(),
  leadId: z.string(),
});

export type CreateColumnInput = z.infer<typeof createColumnSchema>;
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>;
export type RunColumnInput = z.infer<typeof runColumnSchema>;
export type RunCellInput = z.infer<typeof runCellSchema>;

export interface WelddataColumn {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  listId: string;
  name: string;
  type: EnrichmentActionType;
  config: ColumnConfig;
  sortOrder: number;
  createdBy?: string | null;
}

export type WelddataCellStatus = 'pending' | 'running' | 'done' | 'error';

export interface WelddataCell {
  id: string;
  createdAt: string;
  updatedAt: string;
  columnId: string;
  leadId: string;
  status: WelddataCellStatus;
  value?: string | null;
  data?: Record<string, unknown> | null;
  error?: string | null;
  creditsUsed?: number | null;
  ranAt?: string | null;
}
