import { z } from 'zod';

// ============================================================================
// Pickers (Warehouse Workers) — WMS staff that fulfil pick lists.
//
// Backed by the `warehouse_workers` table.
// Permission prefix: `warehouses:*`.
// ============================================================================

export const createPickerSchema = z.object({
  userId: z.string().nullish(),
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  warehouseId: z.string().nullish(),
  role: z.string().default('picker'),
  status: z.enum(['active', 'inactive', 'on_break']).default('active'),
  skills: z.array(z.string()).optional(),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updatePickerSchema = createPickerSchema.partial();

export type CreatePickerInput = z.infer<typeof createPickerSchema>;
export type UpdatePickerInput = z.infer<typeof updatePickerSchema>;
