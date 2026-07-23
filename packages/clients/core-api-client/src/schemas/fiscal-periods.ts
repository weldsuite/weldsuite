import { z } from 'zod';

// `/api/fiscal-periods` — accounting fiscal periods (months/quarters/years).

export const createFiscalPeriodSchema = z.object({
  name: z.string().min(1).max(50),
  entityId: z.string().nullish(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.string().max(30).optional(),
  type: z.string().max(30).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateFiscalPeriodSchema = createFiscalPeriodSchema.partial();

export type CreateFiscalPeriodInput = z.infer<typeof createFiscalPeriodSchema>;
export type UpdateFiscalPeriodInput = z.infer<typeof updateFiscalPeriodSchema>;
