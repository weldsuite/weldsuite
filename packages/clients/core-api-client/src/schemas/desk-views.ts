import { z } from 'zod';

/**
 * `/api/desk/views` — WeldDesk v2 saved inbox views.
 *
 * See packages/db/src/schema/desk-views.ts (deskViews, DeskViewFilter). Mirrors
 * the DeskViewFilter shape (AND of OR-groups) with Zod so the API validates the
 * same structure the DB column types.
 */

export const DESK_VIEW_SORTS = [
  'newest',
  'oldest',
  'waiting_longest',
  'priority_first',
  'next_sla_target',
] as const;

const DESK_VIEW_FILTER_OPERATORS = [
  'eq',
  'ne',
  'in',
  'nin',
  'contains',
  'gt',
  'lt',
  'exists',
  'not_exists',
] as const;

const deskViewFilterConditionSchema = z.object({
  field: z.string().min(1).max(255),
  operator: z.enum(DESK_VIEW_FILTER_OPERATORS),
  value: z.unknown().optional(),
});

export const deskViewFilterSchema = z.object({
  groups: z.array(z.object({ conditions: z.array(deskViewFilterConditionSchema) })),
});

export const createDeskViewSchema = z.object({
  name: z.string().min(1).max(255),
  icon: z.string().max(20).optional(),
  folder: z.string().max(255).optional(),
  filters: deskViewFilterSchema,
  sort: z.enum(DESK_VIEW_SORTS).default('newest'),
  shared: z.boolean().default(false),
  order: z.number().int().optional(),
});

export const updateDeskViewSchema = createDeskViewSchema.partial();

export const listDeskViewsQuerySchema = z.object({
  folder: z.string().max(255).optional(),
});

export type DeskViewFilterInput = z.infer<typeof deskViewFilterSchema>;
export type CreateDeskViewInput = z.infer<typeof createDeskViewSchema>;
export type UpdateDeskViewInput = z.infer<typeof updateDeskViewSchema>;
export type ListDeskViewsQuery = z.infer<typeof listDeskViewsQuerySchema>;
