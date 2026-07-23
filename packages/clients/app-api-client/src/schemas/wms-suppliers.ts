import { z } from 'zod';

// ============================================================================
// WMS Suppliers — vendors for purchasing inventory (WeldStash).
//
// Backed by the `suppliers` table (packages/db/src/schema/suppliers.ts).
// Permission prefix: `suppliers:*`.
// ============================================================================

export const createWmsSupplierSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().max(50).optional(),
  description: z.string().optional(),

  // Primary contact
  contactName: z.string().max(255).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().max(255).optional(),

  // Address
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(100).optional(),

  // Financial
  paymentTerms: z.string().max(100).optional(),
  currency: z.string().max(3).default('USD'),
  taxId: z.string().max(50).nullish(),

  // Lead time / MOV
  defaultLeadTimeDays: z.number().int().optional(),

  // Status
  isActive: z.boolean().default(true),
  rating: z.number().int().min(1).max(5).optional(),
  notes: z.string().optional(),

  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

export const updateWmsSupplierSchema = createWmsSupplierSchema.partial();

export type CreateWmsSupplierInput = z.infer<typeof createWmsSupplierSchema>;
export type UpdateWmsSupplierInput = z.infer<typeof updateWmsSupplierSchema>;
