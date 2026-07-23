import { z } from 'zod';

export const createParcelSchema = z.object({
  trackingNumber: z.string().max(100).optional(),
  referenceNumber: z.string().max(100).optional(),
  carrierId: z.string().nullish(),
  shipmentId: z.string().nullish(),
  status: z.string().max(30).optional(),
  weight: z.union([z.string(), z.number()]).optional(),
  weightUnit: z.string().max(10).optional(),
  dimensions: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateParcelSchema = createParcelSchema.partial();
export type CreateParcelInput = z.infer<typeof createParcelSchema>;
export type UpdateParcelInput = z.infer<typeof updateParcelSchema>;
