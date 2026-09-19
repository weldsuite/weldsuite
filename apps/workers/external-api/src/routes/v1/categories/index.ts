import { createCrudRoute } from '../../../lib/crud-route';
import { schema } from '../../../db';
import { z } from 'zod';
import { eq, like, or, type SQL } from 'drizzle-orm';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 255);
}

const createCategorySchema = z
  .object({
    name: z.string().min(1).max(255),
    slug: z.string().max(255).optional(),
    description: z.string().max(5000).nullish(),
    parentId: z.string().max(30).nullish(),
    position: z.number().int().optional(),
    image: z.string().max(500).nullish(),
    isActive: z.union([z.boolean(), z.number().int()]).optional(),
    type: z.enum(['manual', 'automated']).optional(),
  })
  .passthrough();

const updateCategorySchema = createCategorySchema.partial();

const listCategoriesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  parentId: z.string().optional(),
  type: z.string().optional(),
});

/** Product categories — WeldCommerce merchandising groupings. */
export default createCrudRoute({
  table: schema.categories,
  scope: 'categories',
  label: 'Category',
  idPrefix: 'cat',
  entityType: 'category',
  createSchema: createCategorySchema,
  updateSchema: updateCategorySchema,
  listQuery: listCategoriesQuery,
  filters: (q) => {
    const where: (SQL | undefined)[] = [];
    if (typeof q.search === 'string' && q.search) {
      const term = `%${q.search}%`;
      where.push(or(like(schema.categories.name, term), like(schema.categories.slug, term)));
    }
    if (typeof q.parentId === 'string' && q.parentId) {
      where.push(eq(schema.categories.parentId, q.parentId));
    }
    if (typeof q.type === 'string' && q.type) {
      where.push(eq(schema.categories.type, q.type));
    }
    return where;
  },
  prepareCreate: (body) => {
    const name = String(body.name ?? '');
    const slug = typeof body.slug === 'string' && body.slug ? body.slug : slugify(name) || `cat-${Date.now()}`;
    const isActive =
      typeof body.isActive === 'boolean' ? (body.isActive ? 1 : 0) : (body.isActive as number | undefined);
    return {
      ...body,
      slug,
      type: body.type ?? 'manual',
      isActive: isActive ?? 1,
      depth: 0,
      path: null,
    };
  },
  prepareUpdate: (body) => {
    const next: Record<string, unknown> = { ...body };
    if (typeof body.isActive === 'boolean') {
      next.isActive = body.isActive ? 1 : 0;
    }
    return next;
  },
  eventData: (row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    parentId: row.parentId,
    type: row.type,
  }),
});
