import { z } from 'zod';

// ============================================================================
// Input Schemas — shared client + server validation.
//
// Leads map 1:1 to the dedicated `crm_leads` table. Conversion to a
// customer/opportunity uses /api/leads/:id/convert and produces rows in the
// unified `parties` and `crm_opportunities` tables.
// ============================================================================

export const createLeadSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email(),
  companyName: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  website: z.string().optional(),
  address: z.unknown().optional(),

  source: z.string().optional(),
  channel: z.string().optional(),
  campaign: z.string().optional(),
  medium: z.string().optional(),

  status: z.string().optional(),
  rating: z.string().optional(),
  score: z.number().int().optional(),

  ownerId: z.string().nullish(),

  productInterest: z.array(z.string()).optional(),
  budget: z.unknown().optional(),
  timeline: z.string().optional(),
  authority: z.boolean().optional(),
  need: z.string().optional(),

  notes: z.string().optional(),
  nextAction: z.string().optional(),
});

export const updateLeadSchema = createLeadSchema.partial().extend({
  email: z.string().email().optional(),
});

export const listLeadsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  rating: z.string().optional(),
  ownerId: z.string().optional(),
  isQualified: z.coerce.boolean().optional(),
});

export const convertLeadSchema = z.object({
  createCustomer: z.boolean().default(true),
  createOpportunity: z.boolean().default(false),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type ListLeadsQuery = z.infer<typeof listLeadsQuery>;
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;

// ============================================================================
// Response Types
// ============================================================================

export interface Lead {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  companyName?: string | null;
  title?: string | null;

  email: string;
  phone?: string | null;
  mobile?: string | null;
  website?: string | null;
  address?: unknown;

  source: string;
  channel?: string | null;
  campaign?: string | null;
  medium?: string | null;

  status: string;
  rating?: string | null;
  score?: number | null;

  ownerId?: string | null;
  assignedAt?: string | null;

  isQualified?: boolean | null;
  qualifiedAt?: string | null;
  disqualifiedReason?: string | null;

  productInterest?: unknown;
  budget?: unknown;
  timeline?: string | null;
  authority?: boolean | null;
  need?: string | null;

  convertedAt?: string | null;
  convertedToCustomerId?: string | null;
  convertedToOpportunityId?: string | null;

  firstResponseAt?: string | null;
  lastActivityAt?: string | null;
  numberOfTouches?: number | null;

  notes?: string | null;
  nextAction?: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface LeadConversionResult {
  leadId: string;
  customerId?: string;
  opportunityId?: string;
}

/** The `{ id }` the CRM write routes (leads, opportunities, activities, stages) answer. */
export const recordIdSchema = z.object({ id: z.string() });

/** A `crm_leads` row as the routes return it (the `Lead` shape). */
export const leadSchema = z.object({
  id: z.string(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  fullName: z.string().nullish(),
  companyName: z.string().nullish(),
  title: z.string().nullish(),
  email: z.string(),
  phone: z.string().nullish(),
  mobile: z.string().nullish(),
  website: z.string().nullish(),
  address: z.unknown(),
  source: z.string(),
  channel: z.string().nullish(),
  campaign: z.string().nullish(),
  medium: z.string().nullish(),
  status: z.string(),
  rating: z.string().nullish(),
  score: z.number().nullish(),
  ownerId: z.string().nullish(),
  assignedAt: z.string().nullish(),
  isQualified: z.boolean().nullish(),
  qualifiedAt: z.string().nullish(),
  disqualifiedReason: z.string().nullish(),
  productInterest: z.unknown(),
  budget: z.unknown(),
  timeline: z.string().nullish(),
  authority: z.boolean().nullish(),
  need: z.string().nullish(),
  convertedAt: z.string().nullish(),
  convertedToCustomerId: z.string().nullish(),
  convertedToOpportunityId: z.string().nullish(),
  firstResponseAt: z.string().nullish(),
  lastActivityAt: z.string().nullish(),
  numberOfTouches: z.number().nullish(),
  notes: z.string().nullish(),
  nextAction: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `POST /api/leads/:id/qualify`. */
export const leadQualifiedSchema = z.object({
  id: z.string(),
  isQualified: z.literal(true),
  status: z.literal('qualified'),
});

/** `POST /api/leads/:id/convert` (the `LeadConversionResult` shape). */
export const leadConversionResultSchema = z.object({
  leadId: z.string(),
  customerId: z.string().optional(),
  opportunityId: z.string().optional(),
});
