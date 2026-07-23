// AUTO-COPIED from @weldsuite/core-api-client/schemas/leads
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

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
