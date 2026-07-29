/**
 * Product categories — hierarchy maintenance and automated-membership rules.
 *
 * A category is either:
 *   manual    — members are rows in `category_products`
 *   automated — members are whatever `rules` currently match, evaluated live
 *
 * Evaluating automated membership on read rather than materialising it means a
 * newly-created product joins its categories immediately, with no sync step to
 * forget. The cost is a join per listing, which is bounded by the same cursor
 * pagination every other list endpoint uses.
 */

import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type {
  CategoryRuleColumn,
  CategorySortOrder,
} from '@weldsuite/app-api-client/schemas/product-categories';
import type { Database } from '../db';
import { schema } from '../db';

/**
 * A rule as it may arrive — from a validated request body, or read back out of
 * jsonb where nothing constrains it.
 *
 * Deliberately looser than the Zod type: stored rules can predate a change to
 * the column whitelist, so `column` and `relation` are validated here at use
 * rather than assumed. Both unknown cases resolve to a false predicate, which
 * fails closed — an unrecognised rule shrinks a category, never widens it.
 */
export interface StoredCategoryRule {
  column: string;
  relation: string;
  condition: string;
}

const { categories, categoryProducts, products } = schema;

/** Categories nest, but not without limit — this bounds path length and recursion. */
export const MAX_CATEGORY_DEPTH = 10;

export class CategoryError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'PARENT_NOT_FOUND'
      | 'CYCLE'
      | 'TOO_DEEP'
      | 'SLUG_TAKEN'
      | 'HAS_CHILDREN'
      | 'NOT_MANUAL'
      | 'PRODUCTS_NOT_FOUND',
  ) {
    super(message);
    this.name = 'CategoryError';
  }
}

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

export function slugify(input: string, fallback: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 255);
  return slug || fallback;
}

/**
 * Reserve a unique slug, suffixing `-2`, `-3`, … on collision.
 *
 * `excludeId` lets an update keep its own slug. The suffix loop is bounded;
 * a unique index would be the stronger guarantee, but adding one to a live
 * table with existing duplicates is a migration that can fail outright.
 */
export async function uniqueSlug(
  db: Database,
  desired: string,
  excludeId?: string,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? desired : `${desired}-${attempt + 1}`.slice(0, 255);
    const clash = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.slug, candidate), isNull(categories.deletedAt)))
      .limit(1);
    if (!clash[0] || clash[0].id === excludeId) return candidate;
  }
  throw new CategoryError(`Could not find a free slug based on "${desired}"`, 'SLUG_TAKEN');
}

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

export interface Placement {
  path: string;
  depth: number;
}

/**
 * Resolve where a category sits under `parentId`.
 *
 * `path` is the materialised ancestor chain (`/id/id/id`), which makes
 * "everything under X" a prefix match instead of a recursive query.
 */
export async function resolvePlacement(
  db: Database,
  categoryId: string,
  parentId: string | null | undefined,
): Promise<Placement> {
  if (!parentId) return { path: `/${categoryId}`, depth: 0 };

  const [parent] = await db
    .select({ id: categories.id, path: categories.path, depth: categories.depth })
    .from(categories)
    .where(and(eq(categories.id, parentId), isNull(categories.deletedAt)))
    .limit(1);

  if (!parent) throw new CategoryError(`Parent category ${parentId} not found`, 'PARENT_NOT_FOUND');

  // A parent whose own path contains this category would make the tree a ring.
  // Checking the parent's path catches it at any distance, not just one level.
  const parentPath = parent.path ?? `/${parent.id}`;
  if (parentPath.split('/').includes(categoryId)) {
    throw new CategoryError('A category cannot be moved beneath its own descendant', 'CYCLE');
  }
  if (parentId === categoryId) {
    throw new CategoryError('A category cannot be its own parent', 'CYCLE');
  }

  const depth = (parent.depth ?? 0) + 1;
  if (depth >= MAX_CATEGORY_DEPTH) {
    throw new CategoryError(`Categories may not nest deeper than ${MAX_CATEGORY_DEPTH}`, 'TOO_DEEP');
  }
  return { path: `${parentPath}/${categoryId}`, depth };
}

/**
 * Rewrite `path`/`depth` for every descendant after a category moves.
 *
 * Without this a subtree keeps pointing at its old ancestors and every
 * prefix query against it returns the wrong answer.
 */
export async function reparentDescendants(
  db: Database,
  categoryId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  if (oldPath === newPath) return;
  const depthShift = newPath.split('/').length - oldPath.split('/').length;

  await db
    .update(categories)
    .set({
      // The `::int` cast is load-bearing. `SUBSTRING(x FROM $n)` with an
      // untyped parameter resolves to the POSIX-regex overload
      // `substring(text, text)`, which matches the offset as a pattern and
      // returns NULL — silently blanking the path of every descendant.
      path: sql`${newPath}::text || SUBSTRING(${categories.path} FROM ${oldPath.length + 1}::int)`,
      depth: sql`${categories.depth} + ${depthShift}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        sql`${categories.path} LIKE ${`${oldPath}/%`}`,
        sql`${categories.id} <> ${categoryId}`,
        isNull(categories.deletedAt),
      ),
    );
}

export async function countChildren(db: Database, categoryId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(categories)
    .where(and(eq(categories.parentId, categoryId), isNull(categories.deletedAt)));
  return Number(row?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

type ColumnKind = 'text' | 'numeric' | 'integer' | 'tags';

/**
 * The whitelist that keeps rules out of SQL identifiers.
 *
 * A rule's `column` is a key into this map — never a string spliced into a
 * query. An unrecognised key is rejected, so the only attacker-controlled part
 * of a generated predicate is `condition`, which is always a bound parameter.
 */
const RULE_COLUMNS: Record<CategoryRuleColumn, { col: SQL | ReturnType<typeof sql>; kind: ColumnKind }> = {
  name: { col: sql`${products.name}`, kind: 'text' },
  productType: { col: sql`${products.productType}`, kind: 'text' },
  vendor: { col: sql`${products.vendor}`, kind: 'text' },
  brand: { col: sql`${products.brand}`, kind: 'text' },
  sku: { col: sql`${products.sku}`, kind: 'text' },
  status: { col: sql`${products.status}`, kind: 'text' },
  tag: { col: sql`${products.tags}`, kind: 'tags' },
  price: { col: sql`${products.price}`, kind: 'numeric' },
  compareAtPrice: { col: sql`${products.compareAtPrice}`, kind: 'numeric' },
  weight: { col: sql`${products.weight}`, kind: 'numeric' },
  inventoryQuantity: { col: sql`${products.inventoryQuantity}`, kind: 'integer' },
};

/** Escape the wildcards so a condition containing `%` matches literally. */
function likeLiteral(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

/**
 * Turn one rule into a predicate.
 *
 * Numeric comparisons on a non-numeric condition are treated as "matches
 * nothing" rather than raising: a half-typed rule in the UI shouldn't 500 the
 * listing it is previewing.
 */
function ruleToPredicate(rule: StoredCategoryRule): SQL {
  const entry = RULE_COLUMNS[rule.column as CategoryRuleColumn];
  if (!entry) return sql`FALSE`;
  const { col, kind } = entry;
  const value = rule.condition;

  if (kind === 'tags') {
    // `tags` is a jsonb array of strings; membership is an existence test over
    // its elements rather than a comparison against the array itself.
    const exists = (op: SQL) =>
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) AS tag_value WHERE ${op})`;
    switch (rule.relation) {
      case 'equals':
        return exists(sql`tag_value = ${value}`);
      case 'not_equals':
      case 'not_contains':
        return sql`NOT ${exists(sql`tag_value = ${value}`)}`;
      case 'contains':
        return exists(sql`tag_value ILIKE ${`%${likeLiteral(value)}%`}`);
      case 'starts_with':
        return exists(sql`tag_value ILIKE ${`${likeLiteral(value)}%`}`);
      case 'ends_with':
        return exists(sql`tag_value ILIKE ${`%${likeLiteral(value)}`}`);
      default:
        return sql`FALSE`;
    }
  }

  if (kind === 'numeric' || kind === 'integer') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return sql`FALSE`;
    switch (rule.relation) {
      case 'equals':
        return sql`${col} = ${numeric}`;
      case 'not_equals':
        return sql`(${col} IS DISTINCT FROM ${numeric})`;
      case 'greater_than':
        return sql`${col} > ${numeric}`;
      case 'less_than':
        return sql`${col} < ${numeric}`;
      default:
        return sql`FALSE`;
    }
  }

  switch (rule.relation) {
    case 'equals':
      return sql`${col} = ${value}`;
    case 'not_equals':
      return sql`(${col} IS DISTINCT FROM ${value})`;
    case 'contains':
      return sql`${col} ILIKE ${`%${likeLiteral(value)}%`}`;
    case 'not_contains':
      return sql`(${col} IS NULL OR ${col} NOT ILIKE ${`%${likeLiteral(value)}%`})`;
    case 'starts_with':
      return sql`${col} ILIKE ${`${likeLiteral(value)}%`}`;
    case 'ends_with':
      return sql`${col} ILIKE ${`%${likeLiteral(value)}`}`;
    default:
      return sql`FALSE`;
  }
}

/**
 * Combine a rule set into one predicate, or null when there are no rules.
 *
 * Null is the caller's signal to match nothing. An empty rule set must never
 * degrade into "no filter", which would silently put the whole catalogue in
 * the category.
 */
export function rulesToPredicate(
  rules: StoredCategoryRule[] | null | undefined,
  match: 'all' | 'any' = 'all',
): SQL | null {
  if (!rules || rules.length === 0) return null;
  const predicates = rules.map(ruleToPredicate);
  const combined = match === 'any' ? or(...predicates) : and(...predicates);
  return combined ?? null;
}

// ---------------------------------------------------------------------------
// Member listing
// ---------------------------------------------------------------------------

function orderFor(sortOrder: CategorySortOrder | null | undefined): SQL[] {
  switch (sortOrder) {
    case 'best-selling':
      return [desc(products.salesCount), desc(products.id)];
    case 'alpha-asc':
      return [asc(products.name), asc(products.id)];
    case 'alpha-desc':
      return [desc(products.name), desc(products.id)];
    case 'price-asc':
      return [asc(products.price), asc(products.id)];
    case 'price-desc':
      return [desc(products.price), desc(products.id)];
    case 'created-asc':
      return [asc(products.createdAt), asc(products.id)];
    case 'created-desc':
    default:
      return [desc(products.createdAt), desc(products.id)];
  }
}

export interface MemberPage {
  rows: (typeof products.$inferSelect)[];
  totalCount: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * List the products in a category, whichever way it gets its members.
 *
 * Manual categories default to the curated `position` from the junction table;
 * automated ones have no curation, so they fall back to newest-first.
 */
export async function listCategoryMembers(
  db: Database,
  category: typeof categories.$inferSelect,
  opts: { limit: number; cursor?: string; sortOrder?: CategorySortOrder },
): Promise<MemberPage> {
  const limit = opts.limit;
  const sortOrder = opts.sortOrder ?? (category.sortOrder as CategorySortOrder | null) ?? 'manual';
  const isManual = (category.type ?? 'manual') !== 'automated';

  const base: SQL[] = [isNull(products.deletedAt)];

  if (isManual) {
    const memberIds = await db
      .select({ productId: categoryProducts.productId, position: categoryProducts.position })
      .from(categoryProducts)
      .where(eq(categoryProducts.categoryId, category.id));

    if (memberIds.length === 0) {
      return { rows: [], totalCount: 0, hasMore: false, nextCursor: null };
    }
    base.push(inArray(products.id, memberIds.map((m) => m.productId)));

    if (sortOrder === 'manual') {
      // Curated order lives on the junction row, so page in memory over the
      // membership list — it is already bounded by the category's size and
      // avoids a correlated ordering join.
      const ordered = [...memberIds].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const startIndex = opts.cursor ? ordered.findIndex((m) => m.productId === opts.cursor) + 1 : 0;
      const pageIds = ordered.slice(startIndex, startIndex + limit).map((m) => m.productId);
      const rows = pageIds.length
        ? await db
            .select()
            .from(products)
            .where(and(inArray(products.id, pageIds), isNull(products.deletedAt)))
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered_rows = pageIds.map((id) => byId.get(id)).filter((r): r is typeof products.$inferSelect => !!r);
      const hasMore = startIndex + limit < ordered.length;
      return {
        rows: ordered_rows,
        totalCount: ordered.length,
        hasMore,
        nextCursor: hasMore && pageIds.length ? pageIds[pageIds.length - 1] : null,
      };
    }
  } else {
    const predicate = rulesToPredicate(
      category.rules,
      (category.rulesMatch as 'all' | 'any' | null) ?? 'all',
    );
    // No rules means no members — never the whole catalogue.
    if (!predicate) return { rows: [], totalCount: 0, hasMore: false, nextCursor: null };
    base.push(predicate);
  }

  const effectiveSort: CategorySortOrder = sortOrder === 'manual' ? 'created-desc' : sortOrder;
  const filters = [...base];

  if (opts.cursor) {
    const [cur] = await db
      .select({ createdAt: products.createdAt, id: products.id })
      .from(products)
      .where(eq(products.id, opts.cursor))
      .limit(1);
    if (cur?.createdAt) {
      // Keyset pagination is only sound on the created/id ordering; the other
      // sorts fall back to it so a cursor never skips or repeats rows.
      base.push(
        effectiveSort === 'created-asc'
          ? sql`(${products.createdAt} > ${cur.createdAt} OR (${products.createdAt} = ${cur.createdAt} AND ${products.id} > ${cur.id}))`
          : sql`(${products.createdAt} < ${cur.createdAt} OR (${products.createdAt} = ${cur.createdAt} AND ${products.id} < ${cur.id}))`,
      );
    }
  }

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(products)
      .where(and(...base))
      .orderBy(...orderFor(effectiveSort))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)` })
      .from(products)
      .where(and(...filters)),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page,
    totalCount: Number(countRes[0]?.count ?? 0),
    hasMore,
    nextCursor: hasMore && page.length ? page[page.length - 1].id : null,
  };
}

/** Evaluate a rule set without saving it — powers the rule builder's preview. */
export async function previewMembers(
  db: Database,
  rules: StoredCategoryRule[],
  match: 'all' | 'any',
  sortOrder: CategorySortOrder | undefined,
  limit: number,
): Promise<{ rows: (typeof products.$inferSelect)[]; totalCount: number }> {
  const predicate = rulesToPredicate(rules, match);
  if (!predicate) return { rows: [], totalCount: 0 };
  const where = and(isNull(products.deletedAt), predicate);

  const [rows, countRes] = await Promise.all([
    db.select().from(products).where(where).orderBy(...orderFor(sortOrder ?? 'created-desc')).limit(limit),
    db.select({ count: sql<number>`count(*)` }).from(products).where(where),
  ]);
  return { rows, totalCount: Number(countRes[0]?.count ?? 0) };
}

// ---------------------------------------------------------------------------
// Manual membership
// ---------------------------------------------------------------------------

/**
 * Attach products to a manual category, ignoring ones already attached.
 *
 * Every id is verified to exist first: silently accepting a typo'd product id
 * creates a junction row that joins to nothing and shows up as a phantom
 * member count.
 */
export async function addMembers(
  db: Database,
  category: typeof categories.$inferSelect,
  productIds: string[],
  makeId: () => string,
): Promise<{ added: number; skipped: number }> {
  if ((category.type ?? 'manual') === 'automated') {
    throw new CategoryError(
      'Members of an automated category come from its rules — edit the rules instead',
      'NOT_MANUAL',
    );
  }

  const unique = [...new Set(productIds)];
  const found = await db
    .select({ id: products.id })
    .from(products)
    .where(and(inArray(products.id, unique), isNull(products.deletedAt)));

  if (found.length !== unique.length) {
    const foundIds = new Set(found.map((f) => f.id));
    const missing = unique.filter((id) => !foundIds.has(id));
    throw new CategoryError(`Unknown product ids: ${missing.join(', ')}`, 'PRODUCTS_NOT_FOUND');
  }

  const existing = await db
    .select({ productId: categoryProducts.productId })
    .from(categoryProducts)
    .where(and(eq(categoryProducts.categoryId, category.id), inArray(categoryProducts.productId, unique)));
  const already = new Set(existing.map((e) => e.productId));

  const toInsert = unique.filter((id) => !already.has(id));
  if (toInsert.length === 0) return { added: 0, skipped: unique.length };

  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${categoryProducts.position}), -1)` })
    .from(categoryProducts)
    .where(eq(categoryProducts.categoryId, category.id));
  let position = Number(maxRow?.max ?? -1);

  await db.insert(categoryProducts).values(
    toInsert.map((productId) => ({
      id: makeId(),
      categoryId: category.id,
      productId,
      position: ++position,
      createdAt: new Date(),
    })),
  );

  return { added: toInsert.length, skipped: unique.length - toInsert.length };
}

export async function removeMember(
  db: Database,
  categoryId: string,
  productId: string,
): Promise<boolean> {
  const removed = await db
    .delete(categoryProducts)
    .where(and(eq(categoryProducts.categoryId, categoryId), eq(categoryProducts.productId, productId)))
    .returning({ id: categoryProducts.id });
  return removed.length > 0;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface TreeNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  path: string | null;
  depth: number;
  position: number;
  type: string;
  isActive: boolean;
  children: TreeNode[];
}

/**
 * Build the hierarchy in one pass.
 *
 * Rows whose parent is missing (deleted, or filtered out by `includeInactive`)
 * are surfaced as roots rather than dropped — an orphaned branch should still
 * be reachable and fixable, not invisible.
 */
export function buildTree(
  rows: (typeof categories.$inferSelect)[],
  rootId?: string,
): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      parentId: row.parentId ?? null,
      path: row.path,
      depth: row.depth ?? 0,
      position: row.position ?? 0,
      type: row.type ?? 'manual',
      isActive: (row.isActive ?? 1) === 1,
      children: [],
    });
  }

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortRecursive = (list: TreeNode[]) => {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const child of list) sortRecursive(child.children);
  };
  sortRecursive(roots);

  if (rootId) {
    const found = nodes.get(rootId);
    return found ? [found] : [];
  }
  return roots;
}
