/**
 * Every /api/categories route on pglite, refusals included: the list and its
 * filters, the tree, the rule-builder preview, one category, its members
 * (manual curated order and automated rules, every sort order, cursor
 * paging), create, update (rename, slug collisions, moving a subtree, cycles),
 * delete, and manual membership writes.
 *
 * Conformance-ready: every row is seeded with a fixed id and `created_at`, so
 * both backends see the same ordering, and no assertion depends on a
 * generated id. The database is shared by the whole file, so each section
 * seeds its own rows (distinct prefixes, vendors and parents) and the
 * assertions are scoped to them.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { categoriesRoutes } from './index';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const BASE = '/api/categories';
const READ = 'categories:read';
const CREATE = 'categories:create';
const UPDATE = 'categories:update';
const DELETE = 'categories:delete';

let db: Database;

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute, 0));

function api(...keys: string[]) {
  return createTestApp(BASE, categoriesRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db },
  }).request;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function dataOf<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface Page<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

async function pageOf<T = { id: string }>(res: Response): Promise<Page<T>> {
  return (await res.json()) as Page<T>;
}

async function idsOf(res: Response): Promise<string[]> {
  return (await pageOf(res)).data.map((row) => row.id);
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

async function errorOf(res: Response): Promise<ErrorBody['error']> {
  return ((await res.json()) as ErrorBody).error;
}

interface TreeNode {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  children: TreeNode[];
}

async function seedCategory(id: string, minute: number, values: Partial<typeof schema.categories.$inferInsert> = {}) {
  await db.insert(schema.categories).values({
    id,
    name: id,
    slug: id.replaceAll('_', '-'),
    path: `/${id}`,
    depth: 0,
    createdAt: at(minute),
    updatedAt: at(minute),
    ...values,
  });
}

async function seedProduct(id: string, minute: number, values: Partial<typeof schema.products.$inferInsert> = {}) {
  await db.insert(schema.products).values({
    id,
    name: id,
    slug: id.replaceAll('_', '-'),
    price: '10.00',
    createdAt: at(minute),
    updatedAt: at(minute),
    ...values,
  });
}

async function seedMember(categoryId: string, productId: string, position: number) {
  await db.insert(schema.categoryProducts).values({
    id: `cp_${categoryId.slice(4)}_${productId.slice(5)}`.slice(0, 30),
    categoryId,
    productId,
    position,
    createdAt: at(0),
  });
}

async function categoryRow(id: string) {
  const [row] = await db.select().from(schema.categories).where(eq(schema.categories.id, id)).limit(1);
  return row;
}

const RULE_VENDOR_MEMBER = [{ column: 'vendor', relation: 'equals', condition: 'Member Co' }];

beforeAll(async () => {
  db = (await createPgliteDb()).db;

  // ── tree + list ────────────────────────────────────────────────────────────
  await seedCategory('cat_tr_root', 1, { name: 'Tree Root', slug: 'tree-root' });
  const under = (id: string) => ({ parentId: 'cat_tr_root', path: `/cat_tr_root/${id}`, depth: 1 });
  await seedCategory('cat_tr_b', 2, { name: 'Bolts', ...under('cat_tr_b') });
  // Same position as Bolts: siblings tie-break on the name, in locale order.
  await seedCategory('cat_tr_a', 3, { name: 'anvils', ...under('cat_tr_a') });
  await seedCategory('cat_tr_z', 4, { name: 'Zinc', position: -1, ...under('cat_tr_z') });
  await seedCategory('cat_tr_off', 5, { name: 'Retired', position: 5, isActive: 0, type: 'automated', rules: RULE_VENDOR_MEMBER, ...under('cat_tr_off') });
  await seedCategory('cat_tr_orphan', 6, {
    name: 'Orphan',
    parentId: 'cat_tr_off',
    path: '/cat_tr_root/cat_tr_off/cat_tr_orphan',
    depth: 2,
  });
  await seedCategory('cat_tr_gone', 7, { name: 'Gone', deletedAt: at(8), ...under('cat_tr_gone') });

  // ── preview (vendor-scoped so other sections' products never match) ────────
  await seedProduct('prod_pv_1', 20, {
    name: 'Copper Anvil',
    vendor: 'Acme Preview',
    sku: 'PV-1',
    price: '120.00',
    tags: ['summer', 'metal'],
    inventoryQuantity: 5,
    salesCount: 10,
  });
  await seedProduct('prod_pv_2', 21, {
    name: 'Steel Hammer',
    vendor: 'Acme Preview',
    sku: 'PV-2',
    price: '35.50',
    tags: ['winter'],
    inventoryQuantity: 0,
    salesCount: null,
  });
  await seedProduct('prod_pv_3', 22, {
    name: '100% Iron Tongs',
    vendor: 'Acme Preview',
    sku: 'PV-3',
    price: '15.00',
    tags: null,
    inventoryQuantity: 12,
    salesCount: 3,
  });
  await seedProduct('prod_pv_gone', 23, { name: 'Deleted Anvil', vendor: 'Acme Preview', deletedAt: at(24) });

  // ── members ────────────────────────────────────────────────────────────────
  await seedProduct('prod_mem_a', 30, { name: 'Alpha Clamp', vendor: 'Member Co', price: '30.00', salesCount: 5 });
  await seedProduct('prod_mem_b', 31, { name: 'Bravo Clamp', vendor: 'Member Co', price: '10.00', salesCount: null });
  await seedProduct('prod_mem_c', 32, { name: 'Charlie Clamp', vendor: 'Member Co', price: '20.00', salesCount: 9 });
  await seedProduct('prod_mem_gone', 33, { name: 'Gone Clamp', vendor: 'Member Co', deletedAt: at(34) });

  await seedCategory('cat_mem_manual', 30, { name: 'Curated' });
  await seedMember('cat_mem_manual', 'prod_mem_b', 0);
  await seedMember('cat_mem_manual', 'prod_mem_a', 1);
  await seedMember('cat_mem_manual', 'prod_mem_c', 2);
  await seedMember('cat_mem_manual', 'prod_mem_gone', 3);
  await seedCategory('cat_mem_priced', 31, { name: 'Priced', sortOrder: 'price-asc' });
  await seedMember('cat_mem_priced', 'prod_mem_a', 0);
  await seedMember('cat_mem_priced', 'prod_mem_c', 1);
  await seedCategory('cat_mem_empty', 32, { name: 'Empty' });
  await seedCategory('cat_mem_auto', 33, { name: 'All clamps', type: 'automated', rules: RULE_VENDOR_MEMBER });
  await seedCategory('cat_mem_any', 34, {
    name: 'Some clamps',
    type: 'automated',
    rulesMatch: 'any',
    sortOrder: 'alpha-desc',
    rules: [
      { column: 'name', relation: 'equals', condition: 'Alpha Clamp' },
      { column: 'name', relation: 'equals', condition: 'Charlie Clamp' },
    ],
  });
  // The API refuses this state; a row from before that rule can still hold it.
  await seedCategory('cat_mem_norules', 35, { name: 'No rules', type: 'automated', rules: [] });
  await seedCategory('cat_mem_gone', 36, { name: 'Deleted', deletedAt: at(37) });

  // ── create ─────────────────────────────────────────────────────────────────
  await seedCategory('cat_new_parent', 40, { name: 'New Parent', slug: 'new-parent' });
  await seedCategory('cat_deep9', 41, { name: 'Deep nine', depth: 9, path: '/cat_deep9' });

  // ── update ─────────────────────────────────────────────────────────────────
  await seedCategory('cat_mv_a', 50, { name: 'Move A' });
  await seedCategory('cat_mv_b', 51, { name: 'Move B', parentId: 'cat_mv_a', path: '/cat_mv_a/cat_mv_b', depth: 1 });
  await seedCategory('cat_mv_c', 52, {
    name: 'Move C',
    parentId: 'cat_mv_b',
    path: '/cat_mv_a/cat_mv_b/cat_mv_c',
    depth: 2,
  });
  await seedCategory('cat_mv_p', 53, { name: 'Move Target' });
  await seedCategory('cat_ed', 54, { name: 'Edit Me', slug: 'edit-me' });
  await seedCategory('cat_taken', 55, { name: 'Taken', slug: 'taken-slug' });
  await seedCategory('cat_auto_ed', 56, { name: 'Auto edit', type: 'automated', rules: RULE_VENDOR_MEMBER });

  // ── delete ─────────────────────────────────────────────────────────────────
  await seedCategory('cat_del_parent', 60, { name: 'Delete parent' });
  await seedCategory('cat_del_child', 61, {
    name: 'Delete child',
    parentId: 'cat_del_parent',
    path: '/cat_del_parent/cat_del_child',
    depth: 1,
  });
  await seedMember('cat_del_child', 'prod_mem_a', 0);
  await seedCategory('cat_del_two', 62, { name: 'Two children' });
  for (const [i, id] of ['cat_del_two_1', 'cat_del_two_2'].entries()) {
    await seedCategory(id, 63 + i, { parentId: 'cat_del_two', path: `/cat_del_two/${id}`, depth: 1 });
  }

  // ── membership writes ──────────────────────────────────────────────────────
  await seedCategory('cat_w_manual', 70, { name: 'Write manual' });
  await seedCategory('cat_w_auto', 71, { name: 'Write auto', type: 'automated', rules: RULE_VENDOR_MEMBER });
  await seedProduct('prod_w_1', 70, { name: 'Write one' });
  await seedProduct('prod_w_2', 71, { name: 'Write two' });
  await seedProduct('prod_w_3', 72, { name: 'Write three' });
  await seedProduct('prod_w_gone', 73, { name: 'Write gone', deletedAt: at(74) });
}, 60_000);

// ── GET / ────────────────────────────────────────────────────────────────────

describe('GET /api/categories', () => {
  it('filters by parent and pages with a cursor (deleted rows never listed)', async () => {
    const request = api(READ);
    const first = await pageOf(await request(`${BASE}?parentId=cat_tr_root&limit=2`));
    expect(first.data.map((r) => r.id)).toEqual(['cat_tr_off', 'cat_tr_z']);
    expect(first.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'cat_tr_z' });

    const second = await pageOf(await request(`${BASE}?parentId=cat_tr_root&limit=2&cursor=cat_tr_z`));
    expect(second.data.map((r) => r.id)).toEqual(['cat_tr_a', 'cat_tr_b']);
    expect(second.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });
  });

  it('parentId=null lists roots, and type / search narrow the list', async () => {
    const request = api(READ);
    const roots = await pageOf<{ id: string; parentId: string | null }>(
      await request(`${BASE}?parentId=null&search=Tree`),
    );
    expect(roots.data.map((r) => r.id)).toEqual(['cat_tr_root']);

    const automated = await pageOf<{ id: string; type: string }>(await request(`${BASE}?type=automated&limit=100`));
    expect(automated.data.length).toBeGreaterThan(0);
    expect(automated.data.every((r) => r.type === 'automated')).toBe(true);
    expect(automated.data.map((r) => r.id)).toContain('cat_tr_off');

    // The search is a case-sensitive LIKE over the name and the slug.
    expect(await idsOf(await request(`${BASE}?search=tree-ro`))).toEqual(['cat_tr_root']);
    expect(await idsOf(await request(`${BASE}?search=TREE`))).toEqual([]);
  });

  it('clamps a nonsense limit instead of failing', async () => {
    const request = api(READ);
    const page = await pageOf(await request(`${BASE}?parentId=cat_tr_root&limit=-5`));
    expect(page.data.map((r) => r.id)).toEqual(['cat_tr_off']);
    expect(page.pagination.hasMore).toBe(true);
    const fallback = await pageOf(await request(`${BASE}?parentId=cat_tr_root&limit=abc`));
    expect(fallback.data).toHaveLength(4);
  });

  it('is gated on categories:read', async () => {
    expect((await api(CREATE)(BASE)).status).toBe(403);
  });
});

// ── GET /tree ────────────────────────────────────────────────────────────────

describe('GET /api/categories/tree', () => {
  it('returns one subtree of active categories, siblings by position then name', async () => {
    const res = await api(READ)(`${BASE}/tree?rootId=cat_tr_root`);
    expect(res.status).toBe(200);
    const [root, ...rest] = await dataOf<TreeNode[]>(res);
    expect(rest).toEqual([]);
    expect(root).toMatchObject({
      id: 'cat_tr_root',
      name: 'Tree Root',
      slug: 'tree-root',
      parentId: null,
      path: '/cat_tr_root',
      depth: 0,
      position: 0,
      type: 'manual',
      isActive: true,
    });
    expect(root!.children.map((n) => n.name)).toEqual(['Zinc', 'anvils', 'Bolts']);
    expect(root!.children.every((n) => n.children.length === 0)).toBe(true);
  });

  it('surfaces a child of a filtered-out parent as a root', async () => {
    const forest = await dataOf<TreeNode[]>(await api(READ)(`${BASE}/tree`));
    const orphan = forest.find((n) => n.id === 'cat_tr_orphan');
    expect(orphan).toMatchObject({ parentId: 'cat_tr_off', isActive: true, children: [] });
    expect(forest.some((n) => n.id === 'cat_tr_off')).toBe(false);
    expect(forest.some((n) => n.id === 'cat_tr_gone')).toBe(false);

    const explicitFalse = await dataOf<TreeNode[]>(await api(READ)(`${BASE}/tree?includeInactive=false`));
    expect(explicitFalse.some((n) => n.id === 'cat_tr_orphan')).toBe(true);
  });

  it('includeInactive=true (or 1) keeps inactive categories in place', async () => {
    for (const flag of ['true', '1']) {
      const [root] = await dataOf<TreeNode[]>(await api(READ)(`${BASE}/tree?rootId=cat_tr_root&includeInactive=${flag}`));
      expect(root!.children.map((n) => n.name)).toEqual(['Zinc', 'anvils', 'Bolts', 'Retired']);
      const retired = root!.children[3]!;
      expect(retired).toMatchObject({ isActive: false, type: 'automated' });
      expect(retired.children.map((n) => n.id)).toEqual(['cat_tr_orphan']);
    }
    const zero = await dataOf<TreeNode[]>(await api(READ)(`${BASE}/tree?includeInactive=0`));
    expect(zero.some((n) => n.id === 'cat_tr_orphan')).toBe(true);
  });

  it('answers an empty forest for an unknown root', async () => {
    const res = await api(READ)(`${BASE}/tree?rootId=cat_nope`);
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual([]);
  });

  it('refuses an invalid query and a missing permission', async () => {
    expect((await api(READ)(`${BASE}/tree?includeInactive=yes`)).status).toBe(400);
    expect((await api(READ)(`${BASE}/tree?rootId=${'x'.repeat(31)}`)).status).toBe(400);
    expect((await api(CREATE)(`${BASE}/tree`)).status).toBe(403);
  });
});

// ── POST /preview-members ────────────────────────────────────────────────────

describe('POST /api/categories/preview-members', () => {
  const vendor = { column: 'vendor', relation: 'equals', condition: 'Acme Preview' };

  async function preview(body: Record<string, unknown>) {
    const res = await api(READ)(`${BASE}/preview-members`, json(body));
    expect(res.status).toBe(200);
    const data = await dataOf<{ products: Array<{ id: string }>; totalCount: number }>(res);
    return { ids: data.products.map((p) => p.id), totalCount: data.totalCount };
  }

  it('text rules: contains is case-insensitive, and every match is newest first by default', async () => {
    expect(await preview({ rules: [vendor, { column: 'name', relation: 'contains', condition: 'ANVIL' }] })).toEqual({
      ids: ['prod_pv_1'],
      totalCount: 1,
    });
    expect(await preview({ rules: [vendor] })).toEqual({
      ids: ['prod_pv_3', 'prod_pv_2', 'prod_pv_1'],
      totalCount: 3,
    });
    expect(
      await preview({ rules: [vendor, { column: 'name', relation: 'not_contains', condition: 'steel' }], sortOrder: 'alpha-asc' }),
    ).toEqual({ ids: ['prod_pv_3', 'prod_pv_1'], totalCount: 2 });
    expect(
      await preview({ rules: [vendor, { column: 'sku', relation: 'not_equals', condition: 'PV-1' }], sortOrder: 'created-asc' }),
    ).toEqual({ ids: ['prod_pv_2', 'prod_pv_3'], totalCount: 2 });
    expect(await preview({ rules: [vendor, { column: 'name', relation: 'starts_with', condition: 'steel' }] })).toEqual({
      ids: ['prod_pv_2'],
      totalCount: 1,
    });
    expect(await preview({ rules: [vendor, { column: 'name', relation: 'ends_with', condition: 'TONGS' }] })).toEqual({
      ids: ['prod_pv_3'],
      totalCount: 1,
    });
  });

  it('rulesMatch any ORs the rules, and a % in the condition matches literally', async () => {
    expect(
      await preview({
        rules: [
          { column: 'sku', relation: 'equals', condition: 'PV-2' },
          { column: 'name', relation: 'contains', condition: '100%' },
        ],
        rulesMatch: 'any',
        sortOrder: 'alpha-asc',
      }),
    ).toEqual({ ids: ['prod_pv_3', 'prod_pv_2'], totalCount: 2 });
    expect(await preview({ rules: [vendor, { column: 'name', relation: 'contains', condition: '0%' }] })).toEqual({
      ids: ['prod_pv_3'],
      totalCount: 1,
    });
    expect(await preview({ rules: [vendor, { column: 'name', relation: 'contains', condition: '_' }] })).toEqual({
      ids: [],
      totalCount: 0,
    });
  });

  it('numeric and integer rules compare as numbers; a non-number matches nothing', async () => {
    expect(
      await preview({ rules: [vendor, { column: 'price', relation: 'greater_than', condition: '30' }], sortOrder: 'price-desc' }),
    ).toEqual({ ids: ['prod_pv_1', 'prod_pv_2'], totalCount: 2 });
    expect(await preview({ rules: [vendor, { column: 'price', relation: 'less_than', condition: '20' }] })).toEqual({
      ids: ['prod_pv_3'],
      totalCount: 1,
    });
    expect(await preview({ rules: [vendor, { column: 'price', relation: 'equals', condition: '35.5' }] })).toEqual({
      ids: ['prod_pv_2'],
      totalCount: 1,
    });
    expect(
      await preview({ rules: [vendor, { column: 'price', relation: 'not_equals', condition: '35.50' }], sortOrder: 'price-asc' }),
    ).toEqual({ ids: ['prod_pv_3', 'prod_pv_1'], totalCount: 2 });
    expect(await preview({ rules: [vendor, { column: 'price', relation: 'greater_than', condition: 'abc' }] })).toEqual({
      ids: [],
      totalCount: 0,
    });
    expect(await preview({ rules: [vendor, { column: 'price', relation: 'contains', condition: '1' }] })).toEqual({
      ids: [],
      totalCount: 0,
    });
    expect(await preview({ rules: [vendor, { column: 'inventoryQuantity', relation: 'equals', condition: '0' }] })).toEqual({
      ids: ['prod_pv_2'],
      totalCount: 1,
    });
    expect(
      await preview({
        rules: [vendor, { column: 'inventoryQuantity', relation: 'greater_than', condition: '4' }],
        sortOrder: 'best-selling',
      }),
    ).toEqual({ ids: ['prod_pv_1', 'prod_pv_3'], totalCount: 2 });
  });

  it('tag rules test the elements of the tags array', async () => {
    const tag = (relation: string, condition: string) => ({ column: 'tag', relation, condition });
    expect(await preview({ rules: [vendor, tag('equals', 'summer')] })).toEqual({ ids: ['prod_pv_1'], totalCount: 1 });
    expect(await preview({ rules: [vendor, tag('contains', 'WIN')] })).toEqual({ ids: ['prod_pv_2'], totalCount: 1 });
    expect(await preview({ rules: [vendor, tag('not_contains', 'sum')], sortOrder: 'created-asc' })).toEqual({
      ids: ['prod_pv_2', 'prod_pv_3'],
      totalCount: 2,
    });
    expect(await preview({ rules: [vendor, tag('not_equals', 'winter')], sortOrder: 'created-asc' })).toEqual({
      ids: ['prod_pv_1', 'prod_pv_3'],
      totalCount: 2,
    });
    expect(await preview({ rules: [vendor, tag('starts_with', 'met')] })).toEqual({ ids: ['prod_pv_1'], totalCount: 1 });
    expect(await preview({ rules: [vendor, tag('ends_with', 'TER')] })).toEqual({ ids: ['prod_pv_2'], totalCount: 1 });
    expect(await preview({ rules: [vendor, tag('greater_than', 'a')] })).toEqual({ ids: [], totalCount: 0 });
    expect(await preview({ rules: [vendor, { column: 'name', relation: 'less_than', condition: 'z' }] })).toEqual({
      ids: [],
      totalCount: 0,
    });
  });

  it('limit caps the page but not the count; the rows are whole products', async () => {
    const res = await api(READ)(`${BASE}/preview-members`, json({ rules: [vendor], sortOrder: 'alpha-desc', limit: 1 }));
    const data = await dataOf<{ products: Array<Record<string, unknown>>; totalCount: number }>(res);
    expect(data.totalCount).toBe(3);
    expect(data.products).toHaveLength(1);
    expect(data.products[0]).toMatchObject({
      id: 'prod_pv_2',
      name: 'Steel Hammer',
      price: '35.50',
      tags: ['winter'],
      salesCount: null,
      deletedAt: null,
    });
  });

  it('refuses a bad body and a missing permission', async () => {
    const request = api(READ);
    expect((await request(`${BASE}/preview-members`, json({ rules: [] }))).status).toBe(400);
    expect((await request(`${BASE}/preview-members`, json({}))).status).toBe(400);
    expect(
      (await request(`${BASE}/preview-members`, json({ rules: [{ column: 'cost', relation: 'equals', condition: '1' }] })))
        .status,
    ).toBe(400);
    expect((await request(`${BASE}/preview-members`, json({ rules: [{ ...vendor, condition: '' }] }))).status).toBe(400);
    expect((await request(`${BASE}/preview-members`, json({ rules: [vendor], limit: 0 }))).status).toBe(400);
    expect((await request(`${BASE}/preview-members`, json({ rules: [vendor], sortOrder: 'random' }))).status).toBe(400);
    expect((await api(CREATE)(`${BASE}/preview-members`, json({ rules: [vendor] }))).status).toBe(403);
  });
});

// ── GET /:id ─────────────────────────────────────────────────────────────────

describe('GET /api/categories/:id', () => {
  it('returns the row', async () => {
    const res = await api(READ)(`${BASE}/cat_mem_any`);
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toMatchObject({
      id: 'cat_mem_any',
      name: 'Some clamps',
      type: 'automated',
      rulesMatch: 'any',
      sortOrder: 'alpha-desc',
      isActive: 1,
      productCount: 0,
      deletedAt: null,
    });
  });

  it('404s for a missing or deleted category, 403s without the permission', async () => {
    const missing = await api(READ)(`${BASE}/cat_nope`);
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toEqual({ code: 'NOT_FOUND', message: "Category with ID 'cat_nope' not found" });
    expect((await api(READ)(`${BASE}/cat_mem_gone`)).status).toBe(404);
    expect((await api(CREATE)(`${BASE}/cat_mem_any`)).status).toBe(403);
  });
});

// ── GET /:id/products ────────────────────────────────────────────────────────

describe('GET /api/categories/:id/products', () => {
  const members = (id: string, query = '') => api(READ)(`${BASE}/${id}/products${query}`);

  it('manual: curated order, paged in memory over the junction rows', async () => {
    const first = await pageOf(await members('cat_mem_manual', '?limit=2'));
    expect(first.data.map((r) => r.id)).toEqual(['prod_mem_b', 'prod_mem_a']);
    // The count is the junction rows, a deleted product's included.
    expect(first.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'prod_mem_a' });

    const second = await pageOf(await members('cat_mem_manual', '?limit=2&cursor=prod_mem_a'));
    expect(second.data.map((r) => r.id)).toEqual(['prod_mem_c']);
    expect(second.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });

    // A cursor that is not a member starts over from the top.
    const restart = await pageOf(await members('cat_mem_manual', '?cursor=prod_nope'));
    expect(restart.data.map((r) => r.id)).toEqual(['prod_mem_b', 'prod_mem_a', 'prod_mem_c']);
    expect(restart.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });
  });

  it('manual with a sort order pages in SQL over the live members', async () => {
    const first = await pageOf(await members('cat_mem_manual', '?sortOrder=alpha-desc&limit=2'));
    expect(first.data.map((r) => r.id)).toEqual(['prod_mem_c', 'prod_mem_b']);
    expect(first.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'prod_mem_b' });
    const second = await pageOf(await members('cat_mem_manual', '?sortOrder=alpha-desc&limit=2&cursor=prod_mem_b'));
    expect(second.data.map((r) => r.id)).toEqual(['prod_mem_a']);
    expect(second.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });

    // The category's own sort order applies when the query names none.
    expect(await idsOf(await members('cat_mem_priced'))).toEqual(['prod_mem_c', 'prod_mem_a']);
    const empty = await pageOf(await members('cat_mem_empty'));
    expect(empty).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
  });

  it('automated: rule matches, newest first, keyset-paged on the sort column', async () => {
    const first = await pageOf<Record<string, unknown>>(await members('cat_mem_auto', '?limit=2'));
    expect(first.data.map((r) => r.id)).toEqual(['prod_mem_c', 'prod_mem_b']);
    expect(first.data[0]).toMatchObject({ name: 'Charlie Clamp', price: '20.00', salesCount: 9 });
    expect(first.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'prod_mem_b' });
    const second = await pageOf(await members('cat_mem_auto', '?limit=2&cursor=prod_mem_b'));
    expect(second.data.map((r) => r.id)).toEqual(['prod_mem_a']);
    expect(second.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });

    // A cursor product that does not exist is ignored.
    expect(await idsOf(await members('cat_mem_auto', '?cursor=prod_nope'))).toEqual([
      'prod_mem_c',
      'prod_mem_b',
      'prod_mem_a',
    ]);
  });

  it('automated: every sort order, with a cursor on each kind of key', async () => {
    expect(await idsOf(await members('cat_mem_auto', '?sortOrder=price-asc'))).toEqual([
      'prod_mem_b',
      'prod_mem_c',
      'prod_mem_a',
    ]);
    expect(await idsOf(await members('cat_mem_auto', '?sortOrder=price-asc&cursor=prod_mem_c'))).toEqual(['prod_mem_a']);
    const priceDesc = await pageOf(await members('cat_mem_auto', '?sortOrder=price-desc&limit=1&cursor=prod_mem_a'));
    expect(priceDesc.data.map((r) => r.id)).toEqual(['prod_mem_c']);
    expect(priceDesc.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'prod_mem_c' });

    // Never-sold (null) counts as 0 and sorts last.
    const best = await pageOf(await members('cat_mem_auto', '?sortOrder=best-selling&limit=2'));
    expect(best.data.map((r) => r.id)).toEqual(['prod_mem_c', 'prod_mem_a']);
    expect(best.pagination.cursor).toBe('prod_mem_a');
    expect(await idsOf(await members('cat_mem_auto', '?sortOrder=best-selling&cursor=prod_mem_a'))).toEqual(['prod_mem_b']);

    expect(await idsOf(await members('cat_mem_auto', '?sortOrder=created-asc'))).toEqual([
      'prod_mem_a',
      'prod_mem_b',
      'prod_mem_c',
    ]);
    expect(await idsOf(await members('cat_mem_auto', '?sortOrder=created-asc&cursor=prod_mem_a'))).toEqual([
      'prod_mem_b',
      'prod_mem_c',
    ]);
    expect(await idsOf(await members('cat_mem_auto', '?sortOrder=created-desc&cursor=prod_mem_c'))).toEqual([
      'prod_mem_b',
      'prod_mem_a',
    ]);
    expect(await idsOf(await members('cat_mem_auto', '?sortOrder=alpha-asc&cursor=prod_mem_a'))).toEqual([
      'prod_mem_b',
      'prod_mem_c',
    ]);
    // `manual` on an automated category falls back to newest first.
    expect(await idsOf(await members('cat_mem_auto', '?sortOrder=manual&limit=1'))).toEqual(['prod_mem_c']);
  });

  it('automated: any-match rules and the stored sort order; no rules means no members', async () => {
    expect(await idsOf(await members('cat_mem_any'))).toEqual(['prod_mem_c', 'prod_mem_a']);
    const none = await pageOf(await members('cat_mem_norules'));
    expect(none).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
  });

  it('refuses a bad query, a missing category and a missing permission', async () => {
    expect((await members('cat_mem_auto', '?limit=0')).status).toBe(400);
    expect((await members('cat_mem_auto', '?limit=abc')).status).toBe(400);
    expect((await members('cat_mem_auto', '?sortOrder=random')).status).toBe(400);
    const missing = await members('cat_nope');
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toEqual({ code: 'NOT_FOUND', message: "Category with ID 'cat_nope' not found" });
    expect((await members('cat_mem_gone')).status).toBe(404);
    expect((await api(CREATE)(`${BASE}/cat_mem_auto/products`)).status).toBe(403);
  });
});

// ── POST / ───────────────────────────────────────────────────────────────────

describe('POST /api/categories', () => {
  it('places a child under its parent', async () => {
    const res = await api(CREATE)(BASE, json({ name: 'Child Of New', parentId: 'cat_new_parent', position: 2, color: '#ff0000' }));
    expect(res.status).toBe(201);
    const { id, slug } = await dataOf<{ id: string; slug: string }>(res);
    expect(slug).toBe('child-of-new');
    const row = await categoryRow(id);
    expect(row).toMatchObject({
      parentId: 'cat_new_parent',
      path: `/cat_new_parent/${id}`,
      depth: 1,
      position: 2,
      color: '#ff0000',
      type: 'manual',
      rulesMatch: 'all',
      sortOrder: 'manual',
      isActive: 1,
    });
  });

  it('suffixes a slug that is taken, and stores an automated category with its rules', async () => {
    const res = await api(CREATE)(
      BASE,
      json({
        name: 'New Parent',
        type: 'automated',
        rules: RULE_VENDOR_MEMBER,
        rulesMatch: 'any',
        sortOrder: 'best-selling',
        isActive: false,
      }),
    );
    expect(res.status).toBe(201);
    const { id, slug } = await dataOf<{ id: string; slug: string }>(res);
    expect(slug).toBe('new-parent-2');
    expect(await categoryRow(id)).toMatchObject({
      type: 'automated',
      rules: RULE_VENDOR_MEMBER,
      rulesMatch: 'any',
      sortOrder: 'best-selling',
      isActive: 0,
      path: `/${id}`,
      depth: 0,
    });
  });

  it('refuses a missing parent (404), nesting too deep and an automated category without rules (400)', async () => {
    const request = api(CREATE);
    const missing = await request(BASE, json({ name: 'Lost', parentId: 'cat_nope' }));
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toEqual({ code: 'NOT_FOUND', message: 'Parent category not found' });

    const deep = await request(BASE, json({ name: 'Too deep', parentId: 'cat_deep9' }));
    expect(deep.status).toBe(400);
    expect(await errorOf(deep)).toEqual({
      code: 'BAD_REQUEST',
      message: 'Categories may not nest deeper than 10',
      details: { code: 'TOO_DEEP' },
    });

    expect((await request(BASE, json({ name: 'Rule-less', type: 'automated' }))).status).toBe(400);
    expect((await request(BASE, json({ name: 'x'.repeat(256) }))).status).toBe(400);
    expect((await api(READ)(BASE, json({ name: 'Nope' }))).status).toBe(403);
  });
});

// ── PATCH /:id ───────────────────────────────────────────────────────────────

describe('PATCH /api/categories/:id', () => {
  const patch = (id: string, body: unknown) => api(UPDATE)(`${BASE}/${id}`, json(body, 'PATCH'));

  it('updates the fields in the body and nothing else', async () => {
    const res = await patch('cat_ed', { name: 'Edited', description: 'New text', isActive: false, position: 3 });
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ id: 'cat_ed' });
    expect(await categoryRow('cat_ed')).toMatchObject({
      name: 'Edited',
      description: 'New text',
      isActive: 0,
      position: 3,
      slug: 'edit-me',
      path: '/cat_ed',
    });
  });

  it('slugifies a new slug and suffixes it when another category has it', async () => {
    expect((await patch('cat_ed', { slug: 'Taken Slug' })).status).toBe(200);
    expect((await categoryRow('cat_ed'))?.slug).toBe('taken-slug-2');
    // Its own slug again is no change; another free one is taken as is.
    expect((await patch('cat_ed', { slug: 'taken-slug-2' })).status).toBe(200);
    expect((await categoryRow('cat_ed'))?.slug).toBe('taken-slug-2');
    expect((await patch('cat_taken', { slug: 'taken-slug' })).status).toBe(200);
    expect((await categoryRow('cat_taken'))?.slug).toBe('taken-slug');
    expect((await patch('cat_ed', { slug: 'Edit me!' })).status).toBe(200);
    expect((await categoryRow('cat_ed'))?.slug).toBe('edit-me');
  });

  it('moves a category with its subtree, and back to the root', async () => {
    expect((await patch('cat_mv_a', { parentId: 'cat_mv_p' })).status).toBe(200);
    expect(await categoryRow('cat_mv_a')).toMatchObject({ parentId: 'cat_mv_p', path: '/cat_mv_p/cat_mv_a', depth: 1 });
    expect(await categoryRow('cat_mv_b')).toMatchObject({ parentId: 'cat_mv_a', path: '/cat_mv_p/cat_mv_a/cat_mv_b', depth: 2 });
    expect(await categoryRow('cat_mv_c')).toMatchObject({
      parentId: 'cat_mv_b',
      path: '/cat_mv_p/cat_mv_a/cat_mv_b/cat_mv_c',
      depth: 3,
    });

    expect((await patch('cat_mv_a', { parentId: null })).status).toBe(200);
    expect(await categoryRow('cat_mv_a')).toMatchObject({ parentId: null, path: '/cat_mv_a', depth: 0 });
    expect(await categoryRow('cat_mv_b')).toMatchObject({ path: '/cat_mv_a/cat_mv_b', depth: 1 });
    expect(await categoryRow('cat_mv_c')).toMatchObject({ path: '/cat_mv_a/cat_mv_b/cat_mv_c', depth: 2 });

    // The same parent again moves nothing.
    expect((await patch('cat_mv_b', { parentId: 'cat_mv_a', name: 'Move B2' })).status).toBe(200);
    expect(await categoryRow('cat_mv_b')).toMatchObject({ name: 'Move B2', path: '/cat_mv_a/cat_mv_b', depth: 1 });
  });

  it('refuses a cycle (400 CYCLE) and a missing parent (404)', async () => {
    const cycle = await patch('cat_mv_a', { parentId: 'cat_mv_c' });
    expect(cycle.status).toBe(400);
    expect(await errorOf(cycle)).toEqual({
      code: 'BAD_REQUEST',
      message: 'A category cannot be moved beneath its own descendant',
      details: { code: 'CYCLE' },
    });
    const self = await patch('cat_mv_b', { parentId: 'cat_mv_b' });
    expect(self.status).toBe(400);
    expect((await errorOf(self)).details).toEqual({ code: 'CYCLE' });

    const missing = await patch('cat_mv_a', { parentId: 'cat_nope' });
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toEqual({ code: 'NOT_FOUND', message: 'Parent category not found' });
    expect(await categoryRow('cat_mv_a')).toMatchObject({ parentId: null, path: '/cat_mv_a' });
  });

  it('checks the automated-needs-rules invariant on the merged state', async () => {
    const toAutomated = await patch('cat_taken', { type: 'automated' });
    expect(toAutomated.status).toBe(400);
    expect(await errorOf(toAutomated)).toEqual({
      code: 'BAD_REQUEST',
      message: 'An automated category needs at least one rule',
      details: { code: 'RULES_REQUIRED' },
    });
    expect((await patch('cat_auto_ed', { rules: [] })).status).toBe(400);

    expect((await patch('cat_auto_ed', { type: 'automated', sortOrder: 'price-asc' })).status).toBe(200);
    expect(await categoryRow('cat_auto_ed')).toMatchObject({ type: 'automated', sortOrder: 'price-asc', rules: RULE_VENDOR_MEMBER });
    expect((await patch('cat_auto_ed', { type: 'manual', rules: [], rulesMatch: 'any' })).status).toBe(200);
    expect(await categoryRow('cat_auto_ed')).toMatchObject({ type: 'manual', rules: [], rulesMatch: 'any' });
  });

  it('refuses a missing category, a bad body and a missing permission', async () => {
    const missing = await patch('cat_nope', { name: 'X' });
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toEqual({ code: 'NOT_FOUND', message: "Category with ID 'cat_nope' not found" });
    expect((await patch('cat_mem_gone', { name: 'X' })).status).toBe(404);
    expect((await patch('cat_ed', { name: '' })).status).toBe(400);
    expect((await patch('cat_ed', { sortOrder: 'random' })).status).toBe(400);
    expect((await api(READ)(`${BASE}/cat_ed`, json({ name: 'X' }, 'PATCH'))).status).toBe(403);
  });
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────

describe('DELETE /api/categories/:id', () => {
  const remove = (id: string, keys: string[] = [DELETE]) => api(...keys)(`${BASE}/${id}`, { method: 'DELETE' });

  it('refuses while the category has children (409 HAS_CHILDREN)', async () => {
    const one = await remove('cat_del_parent');
    expect(one.status).toBe(409);
    expect(await errorOf(one)).toEqual({
      code: 'CONFLICT',
      message: 'Category still has 1 child category — move or delete them first',
      details: { code: 'HAS_CHILDREN', childCount: 1 },
    });
    const two = await remove('cat_del_two');
    expect(two.status).toBe(409);
    expect(await errorOf(two)).toMatchObject({
      message: 'Category still has 2 child categories — move or delete them first',
      details: { code: 'HAS_CHILDREN', childCount: 2 },
    });
  });

  it('soft-deletes a leaf and drops its memberships, then the parent can go', async () => {
    expect((await remove('cat_del_child')).status).toBe(204);
    expect((await categoryRow('cat_del_child'))?.deletedAt).toBeInstanceOf(Date);
    const junction = await db
      .select()
      .from(schema.categoryProducts)
      .where(eq(schema.categoryProducts.categoryId, 'cat_del_child'));
    expect(junction).toEqual([]);
    expect((await api(READ)(`${BASE}/cat_del_child`)).status).toBe(404);

    expect((await remove('cat_del_parent')).status).toBe(204);
    expect((await remove('cat_del_parent')).status).toBe(404);
  });

  it('404s for a missing category, 403s without the permission', async () => {
    const missing = await remove('cat_nope');
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toEqual({ code: 'NOT_FOUND', message: "Category with ID 'cat_nope' not found" });
    expect((await remove('cat_del_two', [UPDATE])).status).toBe(403);
  });
});

// ── POST /:id/products, DELETE /:id/products/:productId ─────────────────────

describe('manual membership writes', () => {
  const add = (id: string, productIds: unknown, keys: string[] = [UPDATE]) =>
    api(...keys)(`${BASE}/${id}/products`, json({ productIds }));
  const removeMember = (id: string, productId: string, keys: string[] = [UPDATE]) =>
    api(...keys)(`${BASE}/${id}/products/${productId}`, { method: 'DELETE' });

  it('adds products, counting duplicates and existing members as skipped', async () => {
    const first = await add('cat_w_manual', ['prod_w_1', 'prod_w_2', 'prod_w_1']);
    expect(first.status).toBe(200);
    expect(await dataOf(first)).toEqual({ added: 2, skipped: 0 });

    const second = await add('cat_w_manual', ['prod_w_2', 'prod_w_3']);
    expect(await dataOf(second)).toEqual({ added: 1, skipped: 1 });

    const junction = await db
      .select({ productId: schema.categoryProducts.productId, position: schema.categoryProducts.position })
      .from(schema.categoryProducts)
      .where(eq(schema.categoryProducts.categoryId, 'cat_w_manual'));
    // Positions keep counting through the skipped one.
    expect(junction.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))).toEqual([
      { productId: 'prod_w_1', position: 0 },
      { productId: 'prod_w_2', position: 1 },
      { productId: 'prod_w_3', position: 3 },
    ]);
    expect(await idsOf(await api(READ)(`${BASE}/cat_w_manual/products`))).toEqual(['prod_w_1', 'prod_w_2', 'prod_w_3']);
  });

  it('refuses unknown or deleted products, and an automated category', async () => {
    const unknown = await add('cat_w_manual', ['prod_w_1', 'prod_w_nope', 'prod_w_gone']);
    expect(unknown.status).toBe(400);
    expect(await errorOf(unknown)).toEqual({
      code: 'BAD_REQUEST',
      message: 'Unknown product ids: prod_w_nope, prod_w_gone',
      details: { code: 'PRODUCTS_NOT_FOUND' },
    });

    const automated = await add('cat_w_auto', ['prod_w_1']);
    expect(automated.status).toBe(400);
    expect(await errorOf(automated)).toEqual({
      code: 'BAD_REQUEST',
      message: 'Members of an automated category come from its rules — edit the rules instead',
      details: { code: 'NOT_MANUAL' },
    });
  });

  it('refuses a missing category, a bad body and a missing permission', async () => {
    expect((await add('cat_nope', ['prod_w_1'])).status).toBe(404);
    expect((await add('cat_w_manual', [])).status).toBe(400);
    expect((await add('cat_w_manual', ['x'.repeat(31)])).status).toBe(400);
    expect((await add('cat_w_manual', 'prod_w_1')).status).toBe(400);
    expect((await add('cat_w_manual', ['prod_w_1'], [READ])).status).toBe(403);
  });

  it('removes a member, then 404s for a product that is not one', async () => {
    expect((await removeMember('cat_w_manual', 'prod_w_2')).status).toBe(204);
    expect(await idsOf(await api(READ)(`${BASE}/cat_w_manual/products`))).toEqual(['prod_w_1', 'prod_w_3']);

    const again = await removeMember('cat_w_manual', 'prod_w_2');
    expect(again.status).toBe(404);
    expect(await errorOf(again)).toEqual({ code: 'NOT_FOUND', message: "Category product with ID 'prod_w_2' not found" });
  });

  it('refuses an automated category, a missing category and a missing permission', async () => {
    const automated = await removeMember('cat_w_auto', 'prod_w_1');
    expect(automated.status).toBe(400);
    expect(await errorOf(automated)).toEqual({
      code: 'BAD_REQUEST',
      message: 'Members of an automated category come from its rules — edit the rules instead',
      details: { code: 'NOT_MANUAL' },
    });
    expect((await removeMember('cat_nope', 'prod_w_1')).status).toBe(404);
    expect((await removeMember('cat_w_manual', 'prod_w_1', [READ])).status).toBe(403);
  });
});
