import { z } from 'zod';

// ============================================================================
// Input Schemas — shared client + server validation.
//
// Opportunities map 1:1 to the `crm_opportunities` table.
// ============================================================================

// Non-negative — a deal amount below zero is always a data-entry mistake.
const nonNegativeAmountSchema = z
  .union([z.string(), z.number()])
  .optional()
  .refine(
    (v) => {
      if (v === undefined) return true;
      const n = typeof v === 'number' ? v : Number(v);
      return !Number.isNaN(n) && n >= 0;
    },
    { message: 'Amount must be zero or greater' },
  );

// ISO-4217 code shape (3 uppercase letters, e.g. USD/EUR) — empty string
// still allowed so the field can be cleared.
const currencySchema = z
  .string()
  .max(3)
  .optional()
  .refine((v) => !v || /^[A-Z]{3}$/.test(v), {
    message: 'Currency must be a 3-letter ISO 4217 code (e.g. USD, EUR)',
  });

export const createOpportunitySchema = z.object({
  name: z.string().min(1).max(255),
  customerId: z.string(),
  primaryContactId: z.string().nullish(),
  description: z.string().optional(),

  amount: nonNegativeAmountSchema,
  currency: currencySchema,
  expectedRevenue: z.union([z.string(), z.number()]).optional(),
  recurringRevenue: z.union([z.string(), z.number()]).optional(),
  contractLength: z.number().int().optional(),

  stage: z.string().optional(),
  stageId: z.string().nullish(),
  status: z.string().optional(),
  probability: z.number().int().min(0).max(100).optional(),
  pipeline: z.string().optional(),

  closeDate: z.string().optional(),
  startDate: z.string().optional(),

  ownerId: z.string().nullish(),
  teamMembers: z.array(z.string()).optional(),

  leadSource: z.string().optional(),
  campaign: z.string().optional(),
  type: z.string().optional(),
  category: z.string().optional(),

  nextStep: z.string().optional(),
  nextStepDate: z.string().optional(),

  riskLevel: z.enum(['high', 'medium', 'low', 'none']).optional(),
  riskReason: z.string().optional(),

  proposalUrl: z.string().optional(),
  contractUrl: z.string().optional(),

  tags: z.array(z.string()).optional(),
  customFields: z.unknown().optional(),
});

export const updateOpportunitySchema = createOpportunitySchema.partial();

export const listOpportunitiesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.string().optional(),
  stage: z.string().optional(),
  pipeline: z.string().optional(),
  ownerId: z.string().optional(),
  customerId: z.string().optional(),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type CreateOpportunityInput = z.infer<typeof createOpportunitySchema>;
export type UpdateOpportunityInput = z.infer<typeof updateOpportunitySchema>;
export type ListOpportunitiesQuery = z.infer<typeof listOpportunitiesQuery>;

// ============================================================================
// Response Type
// ============================================================================

export interface Opportunity {
  id: string;
  name: string;
  description?: string | null;

  customerId: string;
  customerName?: string | null;
  primaryContactId?: string | null;

  amount: string;
  currency?: string | null;
  expectedRevenue?: string | null;
  recurringRevenue?: string | null;
  contractLength?: number | null;

  stage: string;
  stageId?: string | null;
  status: string;
  probability?: number | null;
  pipeline?: string | null;

  closeDate: string;
  actualCloseDate?: string | null;
  startDate?: string | null;

  ownerId: string;
  teamMembers?: unknown;

  leadSource?: string | null;
  campaign?: string | null;
  type?: string | null;
  category?: string | null;

  nextStep?: string | null;
  nextStepDate?: string | null;

  riskLevel?: string | null;
  riskReason?: string | null;

  proposalUrl?: string | null;
  contractUrl?: string | null;

  tags?: unknown;
  customFields?: unknown;

  createdAt: string;
  updatedAt: string;
}
