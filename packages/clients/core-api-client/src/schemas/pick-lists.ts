import { z } from 'zod';

export const createPickListSchema = z.object({
  warehouseId: z.string().min(1),
  status: z.string().max(30).optional(),
  assignedTo: z.string().nullish(),
  assignedToName: z.string().nullish(),
  orderIds: z.array(z.string()).optional(),
  pickType: z.string().max(30).optional(),
  priority: z.string().max(20).optional(),
  notes: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updatePickListSchema = createPickListSchema.partial();

export const generatePickListSchema = z.object({
  orderId: z.string().min(1),
  warehouseId: z.string().min(1).optional(),
  assignedTo: z.string().optional(),
  assignedToName: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});

export const assignPickListSchema = z.object({
  assignedTo: z.string().nullable().optional(),
  assignedToName: z.string().nullable().optional(),
});

export const pickItemSchema = z.object({
  quantity: z.number().int().min(0),
  locationBarcode: z.string().min(1).optional(),
  productBarcode: z.string().min(1),
  short: z.boolean().optional(),
});

export type CreatePickListInput = z.infer<typeof createPickListSchema>;
export type UpdatePickListInput = z.infer<typeof updatePickListSchema>;
export type GeneratePickListInput = z.infer<typeof generatePickListSchema>;
export type AssignPickListInput = z.infer<typeof assignPickListSchema>;
export type PickItemInput = z.infer<typeof pickItemSchema>;
