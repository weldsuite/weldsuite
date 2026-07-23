import { z } from 'zod';

export const createShipmentSchema = z.object({
  reference: z.string().max(255).optional(),
  orderId: z.string().nullish(),
  carrierId: z.string().nullish(),
  status: z.string().max(30).optional(),
  shippingAddress: z.unknown().optional(),
  fromAddress: z.unknown().optional(),
  trackingNumber: z.string().max(255).optional(),
  cost: z.union([z.string(), z.number()]).optional(),
  currency: z.string().max(10).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateShipmentSchema = createShipmentSchema.partial();
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;
export type UpdateShipmentInput = z.infer<typeof updateShipmentSchema>;
