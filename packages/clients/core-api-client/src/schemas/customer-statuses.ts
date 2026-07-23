import { z } from 'zod';

// ============================================================================
// Input Schemas (validation on client + server)
// ============================================================================

export const createCustomerStatusSchema = z.object({
  name: z.string().min(1).max(60),
  slug: z.string().min(1).max(30).regex(/^[a-z0-9_]+$/),
  color: z.string().min(1).max(30),
  sortOrder: z.number().int().optional(),
});

export const updateCustomerStatusSchema = createCustomerStatusSchema.partial();

export const reorderCustomerStatusesSchema = z.object({
  ids: z.array(z.string()),
});

// ============================================================================
// Inferred Input Types
// ============================================================================

export type CreateCustomerStatusInput = z.infer<typeof createCustomerStatusSchema>;
export type UpdateCustomerStatusInput = z.infer<typeof updateCustomerStatusSchema>;

// ============================================================================
// Response Types (full entity as returned by API)
// ============================================================================

export interface CustomerStatus {
  id: string;
  name: string;
  slug: string;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
