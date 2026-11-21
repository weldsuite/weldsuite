import { describe, expect, it } from 'vitest';
import type { CommerceCategoryNode } from '@/hooks/queries/use-commerce-queries';
import {
  cleanRules,
  flattenCategoryTree,
  isNumberColumn,
  isRuleColumn,
  newRule,
  relationsFor,
  ruleProblem,
  rulesAreComplete,
  subtreeIds,
  withColumn,
} from './categories';

function node(id: string, depth: number, children: CommerceCategoryNode[] = []): CommerceCategoryNode {
  return {
    id,
    name: id,
    slug: id,
    description: null,
    parentId: null,
    path: null,
    depth,
    type: 'manual',
    rules: null,
    rulesMatch: null,
    isActive: true,
    sortOrder: null,
    publishedAt: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    children,
  };
}

const forest = [node('clothing', 0, [node('shirts', 1, [node('linen', 2)]), node('trousers', 1)]), node('shoes', 0)];

describe('flattenCategoryTree', () => {
  it('lists parents directly above their children, without the children arrays', () => {
    const flat = flattenCategoryTree(forest);
    expect(flat.map((c) => c.id)).toEqual(['clothing', 'shirts', 'linen', 'trousers', 'shoes']);
    expect(flat[0]).not.toHaveProperty('children');
  });
});

describe('subtreeIds', () => {
  it('is the category and everything below it', () => {
    expect([...subtreeIds(forest, 'shirts')].sort()).toEqual(['linen', 'shirts']);
    expect([...subtreeIds(forest, 'shoes')]).toEqual(['shoes']);
  });

  it('is just the category when the tree does not have it (yet)', () => {
    expect([...subtreeIds(forest, 'cat_new')]).toEqual(['cat_new']);
  });
});

describe('rule fields and relations', () => {
  it('offers text relations for text fields, comparisons for numbers, equals for tags', () => {
    expect(relationsFor('name')).toContain('contains');
    expect(relationsFor('name')).not.toContain('greater_than');
    expect(relationsFor('price')).toEqual(['equals', 'not_equals', 'greater_than', 'less_than']);
    expect(relationsFor('tag')).toEqual(['equals']);
    expect(isNumberColumn('inventoryQuantity')).toBe(true);
    expect(isNumberColumn('vendor')).toBe(false);
  });

  it('knows the whitelisted fields', () => {
    expect(isRuleColumn('compareAtPrice')).toBe(true);
    expect(isRuleColumn('password')).toBe(false);
  });

  it('starts a rule on its field’s first relation', () => {
    expect(newRule()).toEqual({ column: 'name', relation: 'equals', condition: '' });
    expect(newRule('tag', 'sale')).toEqual({ column: 'tag', relation: 'equals', condition: 'sale' });
  });

  it('keeps a relation the new field allows and resets one it does not', () => {
    expect(withColumn({ column: 'name', relation: 'not_equals', condition: 'x' }, 'price')).toEqual({
      column: 'price',
      relation: 'not_equals',
      condition: 'x',
    });
    expect(withColumn({ column: 'name', relation: 'contains', condition: 'x' }, 'tag').relation).toBe('equals');
  });
});

describe('rule checks', () => {
  it('needs a value, and a number for number fields', () => {
    expect(ruleProblem({ column: 'name', relation: 'contains', condition: '  ' })).toBe('condition');
    expect(ruleProblem({ column: 'price', relation: 'greater_than', condition: 'ten' })).toBe('number');
    expect(ruleProblem({ column: 'price', relation: 'greater_than', condition: '10.5' })).toBeNull();
    expect(ruleProblem({ column: 'vendor', relation: 'equals', condition: 'Acme' })).toBeNull();
  });

  it('calls a rule set complete only with at least one rule and no problem', () => {
    expect(rulesAreComplete([])).toBe(false);
    expect(rulesAreComplete([{ column: 'name', relation: 'contains', condition: 'shirt' }])).toBe(true);
    expect(
      rulesAreComplete([
        { column: 'name', relation: 'contains', condition: 'shirt' },
        { column: 'price', relation: 'less_than', condition: '' },
      ]),
    ).toBe(false);
  });

  it('trims the values it sends', () => {
    expect(cleanRules([{ column: 'name', relation: 'contains', condition: ' shirt ' }])).toEqual([
      { column: 'name', relation: 'contains', condition: 'shirt' },
    ]);
  });
});
