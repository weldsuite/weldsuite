import { z } from 'zod';

/**
 * Object Templates — named field-sets for create forms (Companies, People,
 * and later Deals, Tickets, Products, …). Backed by `object_templates`.
 *
 * `entityType` is intentionally a permissive slug-shaped string, not a
 * closed enum: adding a new templated object on the front-end's registry
 * must not require a backend deploy. The front-end registry is the
 * canonical list of values that exist in product UI.
 */

const entityTypeSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits, underscores');

/**
 * Convenience type alias. Kept as `string` (not a narrow union) because the
 * universe of values is owned by the front-end registry, not this schema.
 * Callers that want a tighter type can intersect with their own union.
 */
export type ObjectTemplateEntityType = string;

export const objectTemplateSchema = z.object({
  id: z.string(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
  deletedAt: z.union([z.string(), z.date()]).nullable().optional(),
  entityType: entityTypeSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
  fields: z.array(z.string()),
  isDefault: z.boolean(),
  sortOrder: z.number(),
});

export type ObjectTemplate = z.infer<typeof objectTemplateSchema>;

export const createObjectTemplateSchema = z.object({
  entityType: entityTypeSchema,
  name: z.string().min(1).max(150),
  slug: z
    .string()
    .min(1)
    .max(150)
    .regex(/^[a-z0-9_-]+$/, 'lowercase alphanumeric, dashes or underscores'),
  description: z.string().max(500).optional(),
  fields: z.array(z.string().min(1)).min(1, 'Select at least one field'),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const updateObjectTemplateSchema = createObjectTemplateSchema
  .partial()
  .omit({ entityType: true });

export const listObjectTemplatesQuerySchema = z.object({
  entityType: entityTypeSchema.optional(),
});

export type CreateObjectTemplateInput = z.infer<typeof createObjectTemplateSchema>;
export type UpdateObjectTemplateInput = z.infer<typeof updateObjectTemplateSchema>;
export type ListObjectTemplatesQuery = z.infer<typeof listObjectTemplatesQuerySchema>;
