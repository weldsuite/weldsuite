/**
 * DB-backed tests for product categories.
 *
 * Run against pglite with the real tenant migrations so the generated rule SQL
 * — jsonb tag membership, ILIKE escaping, numeric coercion — is exercised as
 * Postgres actually runs it. That generated SQL is the part most worth testing
 * and the part a mocked DB would hide completely.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
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
} from './product-categories';

let db: Database;

async function makeCategory(
  overrides: Partial<typeof schema.categories.$inferInsert> = {},
): Promise<typeof schema.categories.$inferSelect> {
  const id = overrides.id ?? generateId('cat');
  const name = overrides.name ?? `Category ${id}`;
  await db.insert(schema.categories).values({
    id,
    name,
    slug: overrides.slug ?? id,
    path: `/${id}`,
    depth: 0,
    ...overrides,
  });
  const [row] = await db.select().from(schema.categories).where(eq(schema.categories.id, id)).limit(1);
  return row;
}

async function makeProduct(
  overrides: Partial<typeof schema.products.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? generateId('prod');
  await db.insert(schema.products).values({
    id,
    name: overrides.name ?? `Product ${id}`,
    slug: overrides.slug ?? id,
    price: overrides.price ?? '10.00',
    ...overrides,
  });
  return id;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('slugs', () => {
  it('slugifies, and falls back when nothing survives', () => {
    expect(slugify('Summer Sale 2026!', 'x')).toBe('summer-sale-2026');
    expect(slugify('!!!', 'fallback-id')).toBe('fallback-id');
  });

  it('suffixes on collision but lets a row keep its own slug', async () => {
    const cat = await makeCategory({ slug: 'shoes' });
    expect(await uniqueSlug(db, 'shoes')).toBe('shoes-2');
    expect(await uniqueSlug(db, 'shoes', cat.id)).toBe('shoes');
  });
});

describe('hierarchy', () => {
  it('places a root at depth 0 and a child beneath it', async () => {
    const parent = await makeCategory();
    const childId = generateId('cat');
    const placement = await resolvePlacement(db, childId, parent.id);
    expect(placement.depth).toBe(1);
    expect(placement.path).toBe(`/${parent.id}/${childId}`);
  });

  it('rejects an unknown parent', async () => {
    await expect(resolvePlacement(db, generateId('cat'), 'cat_missing')).rejects.toMatchObject({
      code: 'PARENT_NOT_FOUND',
    });
  });

  it('rejects a category becoming its own parent', async () => {
    const cat = await makeCategory();
    await expect(resolvePlacement(db, cat.id, cat.id)).rejects.toMatchObject({ code: 'CYCLE' });
  });

  it('rejects a move beneath its own descendant', async () => {
    const root = await makeCategory();
    const childId = generateId('cat');
    await makeCategory({ id: childId, parentId: root.id, path: `/${root.id}/${childId}`, depth: 1 });
    const grandId = generateId('cat');
    await makeCategory({
      id: grandId, parentId: childId, path: `/${root.id}/${childId}/${grandId}`, depth: 2,
    });

    // Moving the root under its own grandchild would close the loop.
    await expect(resolvePlacement(db, root.id, grandId)).rejects.toMatchObject({ code: 'CYCLE' });
  });

  it('rejects nesting past the depth cap', async () => {
    // MAX_CATEGORY_DEPTH = 10 allows depths 0..9, so build a full ten-level
    // chain — the eleventh is the one that must be refused.
    let parentId: string | null = null;
    let path = '';
    for (let depth = 0; depth < 10; depth++) {
      const id = generateId('cat');
      path = parentId ? `${path}/${id}` : `/${id}`;
      await makeCategory({ id, parentId, path, depth });
      parentId = id;
    }
    await expect(resolvePlacement(db, generateId('cat'), parentId!)).rejects.toMatchObject({
      code: 'TOO_DEEP',
    });
  });

  it('rewrites the whole subtree when a category moves', async () => {
    const oldRoot = await makeCategory();
    const newRoot = await makeCategory();
    const midId = generateId('cat');
    await makeCategory({ id: midId, parentId: oldRoot.id, path: `/${oldRoot.id}/${midId}`, depth: 1 });
    const leafId = generateId('cat');
    await makeCategory({
      id: leafId, parentId: midId, path: `/${oldRoot.id}/${midId}/${leafId}`, depth: 2,
    });

    const placement = await resolvePlacement(db, midId, newRoot.id);
    await db
      .update(schema.categories)
      .set({ parentId: newRoot.id, path: placement.path, depth: placement.depth })
      .where(eq(schema.categories.id, midId));
    await reparentDescendants(db, midId, `/${oldRoot.id}/${midId}`, placement.path);

    const [leaf] = await db.select().from(schema.categories).where(eq(schema.categories.id, leafId));
    expect(leaf.path).toBe(`/${newRoot.id}/${midId}/${leafId}`);
    expect(leaf.depth).toBe(2);
  });

  it('counts children', async () => {
    const parent = await makeCategory();
    await makeCategory({ parentId: parent.id });
    await makeCategory({ parentId: parent.id });
    expect(await countChildren(db, parent.id)).toBe(2);
  });
});

describe('buildTree', () => {
  it('nests by parent and orders by position', () => {
    const rows = [
      { id: 'a', name: 'A', slug: 'a', parentId: null, path: '/a', depth: 0, position: 1, type: 'manual', isActive: 1 },
      { id: 'b', name: 'B', slug: 'b', parentId: null, path: '/b', depth: 0, position: 0, type: 'manual', isActive: 1 },
      { id: 'a1', name: 'A1', slug: 'a1', parentId: 'a', path: '/a/a1', depth: 1, position: 0, type: 'manual', isActive: 1 },
    ] as unknown as (typeof schema.categories.$inferSelect)[];

    const tree = buildTree(rows);
    expect(tree.map((n) => n.id)).toEqual(['b', 'a']);
    expect(tree[1].children.map((n) => n.id)).toEqual(['a1']);
  });

  it('surfaces an orphan as a root rather than dropping it', () => {
    const rows = [
      { id: 'x', name: 'X', slug: 'x', parentId: 'gone', path: '/gone/x', depth: 1, position: 0, type: 'manual', isActive: 1 },
    ] as unknown as (typeof schema.categories.$inferSelect)[];
    expect(buildTree(rows).map((n) => n.id)).toEqual(['x']);
  });
});

describe('manual membership', () => {
  it('adds products, assigns positions, and ignores repeats', async () => {
    const cat = await makeCategory();
    const p1 = await makeProduct();
    const p2 = await makeProduct();

    const first = await addMembers(db, cat, [p1, p2], () => generateId('cprod'));
    expect(first).toEqual({ added: 2, skipped: 0 });

    const second = await addMembers(db, cat, [p1], () => generateId('cprod'));
    expect(second).toEqual({ added: 0, skipped: 1 });

    const rows = await db
      .select()
      .from(schema.categoryProducts)
      .where(eq(schema.categoryProducts.categoryId, cat.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.position).sort()).toEqual([0, 1]);
  });

  it('stays a no-op when the same attach lands twice at once', async () => {
    const cat = await makeCategory();
    const p1 = await makeProduct();

    // A double-submit issues both attaches before either commits, so neither
    // sees the other's row. `category_products_unique` has to absorb it —
    // a read-then-insert would surface the second as a 500.
    const [a, b] = await Promise.all([
      addMembers(db, cat, [p1], () => generateId('cprod')),
      addMembers(db, cat, [p1], () => generateId('cprod')),
    ]);
    expect(a.added + b.added).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);

    const rows = await db
      .select()
      .from(schema.categoryProducts)
      .where(eq(schema.categoryProducts.categoryId, cat.id));
    expect(rows).toHaveLength(1);
  });

  it('rejects unknown product ids instead of creating dangling rows', async () => {
    const cat = await makeCategory();
    await expect(
      addMembers(db, cat, ['prod_nope'], () => generateId('cprod')),
    ).rejects.toMatchObject({ code: 'PRODUCTS_NOT_FOUND' });
  });

  it('refuses manual edits to an automated category', async () => {
    const cat = await makeCategory({ type: 'automated', rules: [{ column: 'vendor', relation: 'equals', condition: 'Acme' }] });
    const p1 = await makeProduct();
    await expect(addMembers(db, cat, [p1], () => generateId('cprod'))).rejects.toBeInstanceOf(CategoryError);
  });

  it('removes a member and reports when there was nothing to remove', async () => {
    const cat = await makeCategory();
    const p1 = await makeProduct();
    await addMembers(db, cat, [p1], () => generateId('cprod'));
    expect(await removeMember(db, cat.id, p1)).toBe(true);
    expect(await removeMember(db, cat.id, p1)).toBe(false);
  });

  it('lists members in curated order', async () => {
    const cat = await makeCategory({ sortOrder: 'manual' });
    const p1 = await makeProduct({ name: 'Zebra' });
    const p2 = await makeProduct({ name: 'Aardvark' });
    await addMembers(db, cat, [p1, p2], () => generateId('cprod'));

    const page = await listCategoryMembers(db, cat, { limit: 10 });
    expect(page.rows.map((r) => r.id)).toEqual([p1, p2]);
    expect(page.totalCount).toBe(2);
  });

  it('returns nothing for an empty manual category', async () => {
    const cat = await makeCategory();
    const page = await listCategoryMembers(db, cat, { limit: 10 });
    expect(page.rows).toEqual([]);
    expect(page.totalCount).toBe(0);
  });
});

describe('automated membership', () => {
  it('matches on a text rule', async () => {
    const vendor = `Acme-${generateId('v')}`;
    const match = await makeProduct({ vendor });
    await makeProduct({ vendor: 'Other' });

    const cat = await makeCategory({
      type: 'automated',
      rules: [{ column: 'vendor', relation: 'equals', condition: vendor }],
    });
    const page = await listCategoryMembers(db, cat, { limit: 10 });
    expect(page.rows.map((r) => r.id)).toEqual([match]);
  });

  it('ANDs rules by default and ORs them on request', async () => {
    const vendor = `V-${generateId('v')}`;
    const both = await makeProduct({ vendor, productType: 'Widget' });
    const vendorOnly = await makeProduct({ vendor, productType: 'Gadget' });

    const rules = [
      { column: 'vendor', relation: 'equals', condition: vendor },
      { column: 'productType', relation: 'equals', condition: 'Widget' },
    ];

    const all = await makeCategory({ type: 'automated', rules, rulesMatch: 'all' });
    expect((await listCategoryMembers(db, all, { limit: 10 })).rows.map((r) => r.id)).toEqual([both]);

    const any = await makeCategory({ type: 'automated', rules, rulesMatch: 'any' });
    const anyIds = (await listCategoryMembers(db, any, { limit: 10 })).rows.map((r) => r.id);
    expect(anyIds).toEqual(expect.arrayContaining([both, vendorOnly]));
  });

  it('compares numerics as numbers, not strings', async () => {
    const marker = `N-${generateId('n')}`;
    // As strings '9' > '100'; as numbers it is the other way round.
    const cheap = await makeProduct({ price: '9.00', brand: marker });
    const dear = await makeProduct({ price: '100.00', brand: marker });

    const cat = await makeCategory({
      type: 'automated',
      rulesMatch: 'all',
      rules: [
        { column: 'brand', relation: 'equals', condition: marker },
        { column: 'price', relation: 'greater_than', condition: '50' },
      ],
    });
    const ids = (await listCategoryMembers(db, cat, { limit: 10 })).rows.map((r) => r.id);
    expect(ids).toEqual([dear]);
    expect(ids).not.toContain(cheap);
  });

  it('matches tags inside the jsonb array', async () => {
    const marker = `T-${generateId('t')}`;
    const tagged = await makeProduct({ brand: marker, tags: ['sale', 'summer'] });
    await makeProduct({ brand: marker, tags: ['winter'] });

    const cat = await makeCategory({
      type: 'automated',
      rulesMatch: 'all',
      rules: [
        { column: 'brand', relation: 'equals', condition: marker },
        { column: 'tag', relation: 'equals', condition: 'sale' },
      ],
    });
    expect((await listCategoryMembers(db, cat, { limit: 10 })).rows.map((r) => r.id)).toEqual([tagged]);
  });

  it('excludes on a negated tag rule, including products with no tags at all', async () => {
    const marker = `T-${generateId('t')}`;
    const untagged = await makeProduct({ brand: marker });
    await makeProduct({ brand: marker, tags: ['clearance'] });

    const cat = await makeCategory({
      type: 'automated',
      rulesMatch: 'all',
      rules: [
        { column: 'brand', relation: 'equals', condition: marker },
        { column: 'tag', relation: 'not_equals', condition: 'clearance' },
      ],
    });
    expect((await listCategoryMembers(db, cat, { limit: 10 })).rows.map((r) => r.id)).toEqual([untagged]);
  });

  it('negates the substring test on `tag not_contains`, not equality', async () => {
    const marker = `T-${generateId('t')}`;
    const summer = await makeProduct({ brand: marker, tags: ['summer'] });
    const winter = await makeProduct({ brand: marker, tags: ['winter'] });

    // No tag *equals* "sum", but `summer` does contain it — folding
    // `not_contains` into the `not_equals` branch would keep `summer`.
    const cat = await makeCategory({
      type: 'automated',
      rulesMatch: 'all',
      rules: [
        { column: 'brand', relation: 'equals', condition: marker },
        { column: 'tag', relation: 'not_contains', condition: 'sum' },
      ],
    });
    const ids = (await listCategoryMembers(db, cat, { limit: 10 })).rows.map((r) => r.id);
    expect(ids).toEqual([winter]);
    expect(ids).not.toContain(summer);
  });

  it('treats % in a condition as a literal, not a wildcard', async () => {
    const marker = `L-${generateId('l')}`;
    const literal = await makeProduct({ name: `${marker} 50% off`, brand: marker });
    await makeProduct({ name: `${marker} plain`, brand: marker });

    const cat = await makeCategory({
      type: 'automated',
      rulesMatch: 'all',
      rules: [
        { column: 'brand', relation: 'equals', condition: marker },
        { column: 'name', relation: 'contains', condition: '50%' },
      ],
    });
    expect((await listCategoryMembers(db, cat, { limit: 10 })).rows.map((r) => r.id)).toEqual([literal]);
  });

  it('matches nothing when an automated category has no rules', async () => {
    await makeProduct();
    const cat = await makeCategory({ type: 'automated', rules: [] });
    const page = await listCategoryMembers(db, cat, { limit: 10 });
    expect(page.rows).toEqual([]);
    expect(page.totalCount).toBe(0);
  });

  it('fails closed on a rule naming an unknown column', async () => {
    const marker = `U-${generateId('u')}`;
    await makeProduct({ brand: marker });
    const cat = await makeCategory({
      type: 'automated',
      rulesMatch: 'all',
      rules: [{ column: 'secret_column', relation: 'equals', condition: marker }],
    });
    expect((await listCategoryMembers(db, cat, { limit: 10 })).rows).toEqual([]);
  });

  it('ignores manual memberships once a category is automated', async () => {
    const marker = `M-${generateId('m')}`;
    const manualOnly = await makeProduct();
    const ruleMatch = await makeProduct({ brand: marker });

    const cat = await makeCategory();
    await addMembers(db, cat, [manualOnly], () => generateId('cprod'));

    await db
      .update(schema.categories)
      .set({ type: 'automated', rules: [{ column: 'brand', relation: 'equals', condition: marker }] })
      .where(eq(schema.categories.id, cat.id));
    const [updated] = await db.select().from(schema.categories).where(eq(schema.categories.id, cat.id));

    expect((await listCategoryMembers(db, updated, { limit: 10 })).rows.map((r) => r.id)).toEqual([ruleMatch]);
  });

  it('sorts by price when asked', async () => {
    const marker = `S-${generateId('s')}`;
    const cheap = await makeProduct({ brand: marker, price: '5.00' });
    const dear = await makeProduct({ brand: marker, price: '500.00' });

    const cat = await makeCategory({
      type: 'automated',
      rules: [{ column: 'brand', relation: 'equals', condition: marker }],
      sortOrder: 'price-desc',
    });
    expect((await listCategoryMembers(db, cat, { limit: 10 })).rows.map((r) => r.id)).toEqual([dear, cheap]);

    const asc = await listCategoryMembers(db, cat, { limit: 10, sortOrder: 'price-asc' });
    expect(asc.rows.map((r) => r.id)).toEqual([cheap, dear]);
  });

  it('pages a non-created sort without skipping or repeating', async () => {
    const marker = `K-${generateId('k')}`;
    // Insertion order is deliberately the reverse of price order: a cursor
    // keyed on `created_at` while ordering by price would page the wrong set.
    const prices = ['10.00', '40.00', '20.00', '50.00', '30.00'];
    for (const price of prices) await makeProduct({ brand: marker, price });

    const cat = await makeCategory({
      type: 'automated',
      rules: [{ column: 'brand', relation: 'equals', condition: marker }],
      sortOrder: 'price-asc',
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await listCategoryMembers(db, cat, { limit: 2, cursor });
      seen.push(...result.rows.map((r) => r.id));
      if (!result.hasMore) break;
      cursor = result.nextCursor ?? undefined;
    }

    const walked = await Promise.all(
      seen.map(async (id) => {
        const [row] = await db.select().from(schema.products).where(eq(schema.products.id, id)).limit(1);
        return row.price;
      }),
    );
    expect(new Set(seen).size).toBe(prices.length);
    expect(walked).toEqual([...prices].sort((a, b) => Number(a) - Number(b)));
  });
});

describe('previewMembers', () => {
  it('evaluates rules without persisting anything', async () => {
    const marker = `P-${generateId('p')}`;
    const match = await makeProduct({ vendor: marker });

    const result = await previewMembers(
      db,
      [{ column: 'vendor', relation: 'equals', condition: marker }],
      'all',
      undefined,
      10,
    );
    expect(result.rows.map((r) => r.id)).toEqual([match]);
    expect(result.totalCount).toBe(1);

    const stored = await db
      .select()
      .from(schema.categoryProducts)
      .where(eq(schema.categoryProducts.productId, match));
    expect(stored).toEqual([]);
  });
});
