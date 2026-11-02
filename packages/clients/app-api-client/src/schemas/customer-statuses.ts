import { z } from 'zod';

// ============================================================================
// Customer Statuses — workspace-defined lifecycle states for customers
// (e.g. prospect, active, churned). Slugs must be unique per workspace;
// built-in slugs (prospect, active, inactive, churned, blacklisted) are
// reserved and cannot be created via API.
//
// Backed by the `crm_customer_statuses` table.
// Permission prefix: `customers:read` (list), `settings:manage` (mutate).
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

export type CreateCustomerStatusInput = z.infer<typeof createCustomerStatusSchema>;
export type UpdateCustomerStatusInput = z.infer<typeof updateCustomerStatusSchema>;
export type ReorderCustomerStatusesInput = z.infer<typeof reorderCustomerStatusesSchema>;

/** A `crm_customer_statuses` row as the routes return it. */
export const customerStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  color: z.string(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
