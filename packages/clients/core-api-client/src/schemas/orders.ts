import { z } from 'zod';

export const createOrderSchema = z.object({
  orderNumber: z.string().max(100).optional(),
  customerId: z.string().nullish(),
  websiteId: z.string().nullish(),
  status: z.string().max(30).optional(),
  currency: z.string().max(10).optional(),
  subtotal: z.union([z.string(), z.number()]).optional(),
  taxTotal: z.union([z.string(), z.number()]).optional(),
  total: z.union([z.string(), z.number()]).optional(),
  shippingAddress: z.unknown().optional(),
  billingAddress: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateOrderSchema = createOrderSchema.partial();
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
