import { z } from 'zod';

// `/api/fx-rates` — foreign exchange rates (append-only; no soft delete).

export const createFxRateSchema = z.object({
  fromCurrency: z.string().min(1).max(10),
  toCurrency: z.string().min(1).max(10),
  rate: z.union([z.string(), z.number()]),
  rateDate: z.string().optional(),
  source: z.string().max(50).optional(),
  entityId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateFxRateSchema = createFxRateSchema.partial();

export type CreateFxRateInput = z.infer<typeof createFxRateSchema>;
export type UpdateFxRateInput = z.infer<typeof updateFxRateSchema>;
