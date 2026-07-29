/**
 * Category routes — flat /api/categories/* surface backed by `categories`.
 *
 * A category is hierarchical and gets its members one of two ways: `manual`
 * (curated rows in `category_products`) or `automated` (a rule set evaluated
 * live against `products`). This is WeldCommerce's equivalent of Shopify's
 * custom and smart collections, folded into one nestable object — see
 * .claude/weldcommerce-plan.md.
 *
 * Permissions: categories:read | categories:create | categories:update | categories:delete.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  addCategoryProductsSchema,
  categoryProductsQuerySchema,
  categoryTreeQuerySchema,
  createProductCategorySchema,
  previewCategoryMembersSchema,
  updateProductCategorySchema,
} from '@weldsuite/app-api-client/schemas/product-categories';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  addMembers,
  buildTree,
  CategoryError,
  countChildren,
  listCategoryMembers,
  previewMembers,
  removeMember,
  reparentDescendants,
  resolvePlacement,
  slugify,
  uniqueSlug,
} from '../../services/product-categories';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.categories;

/** Category errors name a caller-fixable condition; anything else is a 500. */
function categoryError(c: Context, err: unknown, fallback: string) {
  if (err instanceof CategoryError) {
    if (err.code === 'PARENT_NOT_FOUND') return error.notFound(c, 'Parent category');
    if (err.code === 'HAS_CHILDREN' || err.code === 'SLUG_TAKEN') {
      return error.conflict(c, err.message, { code: err.code });
    }
    return error.badRequest(c, err.message, { code: err.code });
  }
  console.error(`[app-api/categories] ${fallback}:`, err);
  return error.internal(c, fallback);
}

app.get('/', requirePermission('categories:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  // `parentId=null` is the only way to ask for roots — an absent param means
  // "any parent", so the two cases cannot share a branch.
  if (q.parentId === 'null') conditions.push(isNull(t.parentId));
  else if (q.parentId !== undefined && q.parentId !== '') conditions.push(eq(t.parentId, q.parentId));
  if (q.type !== undefined && q.type !== '') conditions.push(eq(t.type, q.type));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.slug, term))!);
  }

  const filterConditions = [...conditions];
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/categories] list failed:', err);
    return error.internal(c, 'Failed to list categories');
  }
});

/**
 * The whole hierarchy in one request.
 *
 * Nesting is capped at MAX_CATEGORY_DEPTH, so a workspace's category set is
 * small enough to assemble in memory — cheaper than the client issuing a
 * request per level.
 */
app.get('/tree', requirePermission('categories:read'), zValidator('query', categoryTreeQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  try {
    const conditions: any[] = [isNull(t.deletedAt)];
    if (!q.includeInactive) conditions.push(eq(t.isActive, 1));
    const rows = await db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(asc(t.depth), asc(t.position));
    return success(c, buildTree(rows, q.rootId));
  } catch (err) {
    console.error('[app-api/categories] tree failed:', err);
    return error.internal(c, 'Failed to build category tree');
  }
});

/**
 * Evaluate a rule set without saving it, so the rule builder can show what an
 * automated category would capture before it is created.
 */
app.post('/preview-members', requirePermission('categories:read'), zValidator('json', previewCategoryMembersSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  try {
    const { rows, totalCount } = await previewMembers(
      db,
      body.rules,
      body.rulesMatch ?? 'all',
      body.sortOrder,
      body.limit ?? 25,
    );
    return success(c, { products: rows, totalCount });
  } catch (err) {
    console.error('[app-api/categories] preview failed:', err);
    return error.internal(c, 'Failed to preview category members');
  }
});

app.get('/:id', requirePermission('categories:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Category', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/categories] get failed:', err);
    return error.internal(c, 'Failed to fetch category');
  }
});

/** The products in a category, however it gets them. */
app.get('/:id/products', requirePermission('categories:read'), zValidator('query', categoryProductsQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const q = c.req.valid('query');
  try {
    const [category] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!category) return error.notFound(c, 'Category', id);

    const page = await listCategoryMembers(db, category, {
      limit: q.limit ?? 25,
      cursor: q.cursor,
      sortOrder: q.sortOrder,
    });
    return list(c, page.rows, cursorPagination(page.totalCount, page.hasMore, page.nextCursor));
  } catch (err) {
    console.error('[app-api/categories] list members failed:', err);
    return error.internal(c, 'Failed to list category products');
  }
});

app.post('/', requirePermission('categories:create'), zValidator('json', createProductCategorySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const id = generateId('cat');
  const now = new Date();

  try {
    const slug = await uniqueSlug(db, data.slug ? slugify(data.slug, id) : slugify(data.name, id));
    const placement = await resolvePlacement(db, id, data.parentId);

    await db.insert(t).values({
      id,
      name: data.name,
      slug,
      description: data.description ?? null,
      parentId: data.parentId ?? null,
      path: placement.path,
      depth: placement.depth,
      position: data.position ?? 0,
      image: data.image ?? null,
      icon: data.icon ?? null,
      color: data.color ?? null,
      metaTitle: data.metaTitle ?? null,
      metaDescription: data.metaDescription ?? null,
      isActive: data.isActive === false ? 0 : 1,
      publishedAt: data.publishedAt ?? null,
      type: data.type ?? 'manual',
      rules: data.rules ?? null,
      rulesMatch: data.rulesMatch ?? 'all',
      sortOrder: data.sortOrder ?? 'manual',
      customFields: data.customFields,
      createdAt: now,
      updatedAt: now,
    });

    publishEntityEvent({
      c,
      entityType: 'category',
      entityId: id,
      action: 'created',
      data: { id, name: data.name, slug, parentId: data.parentId ?? undefined },
    });
    return success(c, { id, slug }, 201);
  } catch (err) {
    return categoryError(c, err, 'Failed to create category');
  }
});

app.patch('/:id', requirePermission('categories:update'), zValidator('json', updateProductCategorySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const now = new Date();

  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Category', id);

    const update: Record<string, unknown> = { updatedAt: now };

    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.position !== undefined) update.position = data.position;
    if (data.image !== undefined) update.image = data.image;
    if (data.icon !== undefined) update.icon = data.icon;
    if (data.color !== undefined) update.color = data.color;
    if (data.metaTitle !== undefined) update.metaTitle = data.metaTitle;
    if (data.metaDescription !== undefined) update.metaDescription = data.metaDescription;
    if (data.isActive !== undefined) update.isActive = data.isActive ? 1 : 0;
    if (data.publishedAt !== undefined) update.publishedAt = data.publishedAt;
    if (data.type !== undefined) update.type = data.type;
    if (data.rules !== undefined) update.rules = data.rules;
    if (data.rulesMatch !== undefined) update.rulesMatch = data.rulesMatch;
    if (data.sortOrder !== undefined) update.sortOrder = data.sortOrder;
    if (data.customFields !== undefined) update.customFields = data.customFields;

    if (data.slug !== undefined && data.slug !== existing.slug) {
      update.slug = await uniqueSlug(db, slugify(data.slug, id), id);
    }

    // Moving a category rewrites its own placement and its whole subtree's.
    let reparent: { oldPath: string; newPath: string } | null = null;
    if (data.parentId !== undefined && (data.parentId ?? null) !== (existing.parentId ?? null)) {
      const placement = await resolvePlacement(db, id, data.parentId);
      update.parentId = data.parentId ?? null;
      update.path = placement.path;
      update.depth = placement.depth;
      reparent = { oldPath: existing.path ?? `/${id}`, newPath: placement.path };
    }

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    if (reparent) await reparentDescendants(db, id, reparent.oldPath, reparent.newPath);

    publishEntityEvent({
      c,
      entityType: 'category',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: (update.name as string | undefined) ?? existing.name,
        slug: (update.slug as string | undefined) ?? existing.slug,
        parentId: (update.parentId as string | null | undefined) ?? existing.parentId,
      },
    });
    return success(c, { id });
  } catch (err) {
    return categoryError(c, err, 'Failed to update category');
  }
});

/**
 * Soft-delete a category.
 *
 * Refuses while it still has children: soft-deleting a parent would strand its
 * subtree pointing at a row the tree endpoint filters out. Reparent or delete
 * the children first. Manual memberships are removed, since the junction rows
 * are meaningless without the category.
 */
app.delete('/:id', requirePermission('categories:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Category', id);

    const children = await countChildren(db, id);
    if (children > 0) {
      return error.conflict(
        c,
        `Category still has ${children} child ${children === 1 ? 'category' : 'categories'} — move or delete them first`,
        { code: 'HAS_CHILDREN', childCount: children },
      );
    }

    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    await db.delete(schema.categoryProducts).where(eq(schema.categoryProducts.categoryId, id));

    publishEntityEvent({ c, entityType: 'category', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    return categoryError(c, err, 'Failed to delete category');
  }
});

/** Attach products to a manual category. */
app.post('/:id/products', requirePermission('categories:update'), zValidator('json', addCategoryProductsSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { productIds } = c.req.valid('json');
  try {
    const [category] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!category) return error.notFound(c, 'Category', id);

    const result = await addMembers(db, category, productIds, () => generateId('cprod'));

    publishEntityEvent({
      c,
      entityType: 'category',
      entityId: id,
      action: 'updated',
      data: { id, name: category.name, slug: category.slug, parentId: category.parentId },
    });
    return success(c, result);
  } catch (err) {
    return categoryError(c, err, 'Failed to add products to category');
  }
});

app.delete('/:id/products/:productId', requirePermission('categories:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const productId = c.req.param('productId');
  try {
    const [category] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!category) return error.notFound(c, 'Category', id);
    if ((category.type ?? 'manual') === 'automated') {
      return error.badRequest(
        c,
        'Members of an automated category come from its rules — edit the rules instead',
        { code: 'NOT_MANUAL' },
      );
    }

    const removed = await removeMember(db, id, productId);
    if (!removed) return error.notFound(c, 'Category product', productId);

    publishEntityEvent({
      c,
      entityType: 'category',
      entityId: id,
      action: 'updated',
      data: { id, name: category.name, slug: category.slug, parentId: category.parentId },
    });
    return noContent(c);
  } catch (err) {
    return categoryError(c, err, 'Failed to remove product from category');
  }
});

export const categoriesRoutes = app;
