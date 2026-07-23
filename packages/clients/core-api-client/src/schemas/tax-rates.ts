import { z } from 'zod';

// `/api/tax-rates` — workspace tax rate definitions.

export const createTaxRateSchema = z.object({
  name: z.string().min(1).max(100),
  code: z.string().max(50).optional(),
  rate: z.union([z.string(), z.number()]),
  jurisdiction: z.string().max(50).optional(),
  entityId: z.string().nullish(),
  isCompound: z.boolean().optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateTaxRateSchema = createTaxRateSchema.partial();

export type CreateTaxRateInput = z.infer<typeof createTaxRateSchema>;
export type UpdateTaxRateInput = z.infer<typeof updateTaxRateSchema>;
