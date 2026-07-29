import { z } from 'zod';

// ============================================================================
// Product categories — WeldCommerce merchandising groupings.
//
// A category is hierarchical (parent/child) and is either:
//   manual    — members are rows in `category_products`
//   automated — members are whatever `rules` currently match
//
// This folds Shopify's flat manual/smart *collections* into the repo's existing
// hierarchical `categories` table. See .claude/weldcommerce-plan.md for why.
//
// Backed by apps/workers/app-api/src/services/product-categories.ts.
// Permission prefix: `categories:*`.
// ============================================================================

/**
 * Product fields a rule may test. This list is the security boundary: the
 * server maps each name to a column object, so an unknown value is rejected
 * rather than concatenated into SQL.
 */
export const categoryRuleColumnSchema = z.enum([
  'name',
  'productType',
  'vendor',
  'brand',
  'sku',
  'status',
  'tag',
  'price',
  'compareAtPrice',
  'weight',
  'inventoryQuantity',
]);

export const categoryRuleRelationSchema = z.enum([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'less_than',
]);

export const categoryRuleSchema = z.object({
  column: categoryRuleColumnSchema,
  relation: categoryRuleRelationSchema,
  /** Compared value. Always bound as a parameter, never interpolated. */
  condition: z.string().min(1).max(255),
});

export const categorySortOrderSchema = z.enum([
  'manual',
  'best-selling',
  'alpha-asc',
  'alpha-desc',
  'price-asc',
  'price-desc',
  'created-desc',
  'created-asc',
]);

export const categoryTypeSchema = z.enum(['manual', 'automated']);

const categoryBase = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().max(255).optional(),
  description: z.string().max(5000).nullish(),

  parentId: z.string().max(30).nullish(),
  position: z.number().int().optional(),

  image: z.string().max(500).nullish(),
  icon: z.string().max(100).nullish(),
  color: z.string().max(20).nullish(),

  metaTitle: z.string().max(255).nullish(),
  metaDescription: z.string().max(500).nullish(),

  isActive: z.boolean().optional(),
  publishedAt: z.coerce.date().nullish(),

  type: categoryTypeSchema.optional(),
  rules: z.array(categoryRuleSchema).max(50).optional(),
  rulesMatch: z.enum(['all', 'any']).optional(),
  sortOrder: categorySortOrderSchema.optional(),

  customFields: z.record(z.unknown()).optional(),
});

/**
 * An automated category with no rules would match the entire catalogue, which
 * is never what someone means — it is a half-filled form. Require at least one.
 */
const requireRulesWhenAutomated = <T extends z.ZodTypeAny>(s: T) =>
  s.superRefine((val, ctx) => {
    const v = val as { type?: string; rules?: unknown[] };
    if (v.type === 'automated' && (!v.rules || v.rules.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules'],
        message: 'An automated category needs at least one rule',
      });
    }
  });

export const createProductCategorySchema = requireRulesWhenAutomated(categoryBase);

/**
 * Deliberately *not* refined.
 *
 * A refinement on a partial schema only sees the fields the body happens to
 * carry, which gets the invariant wrong in both directions: `{ type:
 * 'automated' }` on a category that already has rules would be rejected, while
 * `{ rules: [] }` on an already-automated one would pass and persist. The
 * merged (existing + patch) state is what has to satisfy it, so the PATCH
 * handler checks it — see {@link automatedWithoutRules}.
 */
export const updateProductCategorySchema = categoryBase.partial();

/**
 * Does the state a PATCH would leave behind violate the automated/rules
 * invariant? Callers pass the merged type and rules.
 */
export function automatedWithoutRules(
  type: string | null | undefined,
  rules: unknown[] | null | undefined,
): boolean {
  return type === 'automated' && (!rules || rules.length === 0);
}

/** Attach products to a manual category. */
export const addCategoryProductsSchema = z.object({
  productIds: z.array(z.string().min(1).max(30)).min(1).max(200),
});

/** Evaluate a rule set without saving it. */
export const previewCategoryMembersSchema = z.object({
  rules: z.array(categoryRuleSchema).min(1).max(50),
  rulesMatch: z.enum(['all', 'any']).optional(),
  sortOrder: categorySortOrderSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const categoryProductsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortOrder: categorySortOrderSchema.optional(),
});

export const categoryTreeQuerySchema = z.object({
  /** Subtree root. Omitted returns the whole forest. */
  rootId: z.string().max(30).optional(),
  // Not `z.coerce.boolean()`: that runs the value through `Boolean()`, and every
  // non-empty string is truthy — so `?includeInactive=false` would read as true.
  includeInactive: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .optional(),
});

export type CategoryRuleColumn = z.infer<typeof categoryRuleColumnSchema>;
export type CategoryRuleRelation = z.infer<typeof categoryRuleRelationSchema>;
export type CategoryRuleInput = z.infer<typeof categoryRuleSchema>;
export type CategorySortOrder = z.infer<typeof categorySortOrderSchema>;
export type CategoryType = z.infer<typeof categoryTypeSchema>;
export type CreateProductCategoryInput = z.infer<typeof createProductCategorySchema>;
export type UpdateProductCategoryInput = z.infer<typeof updateProductCategorySchema>;
export type AddCategoryProductsInput = z.infer<typeof addCategoryProductsSchema>;
export type PreviewCategoryMembersInput = z.infer<typeof previewCategoryMembersSchema>;
export type CategoryProductsQuery = z.infer<typeof categoryProductsQuerySchema>;
export type CategoryTreeQuery = z.infer<typeof categoryTreeQuerySchema>;

/** A category with its children attached — the shape of `GET /tree`. */
export interface CategoryTreeNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  path: string | null;
  depth: number;
  position: number;
  type: string;
  isActive: boolean;
  children: CategoryTreeNode[];
}
