import { describe, expect, it } from 'vitest';
import type { DimensionValue } from '@/lib/api/domains/weldbooks';
import { buildDimensionRows, descendantIds } from './dimension-tree';

function value(id: string, name: string, parentId: string | null = null): DimensionValue {
  return {
    id,
    entityId: 'ent_1',
    dimension: 'class',
    name,
    code: null,
    parentId,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const values = [
  value('b', 'Beta'),
  value('a', 'Alpha'),
  value('a2', 'Alpha 2', 'a'),
  value('a1', 'Alpha 1', 'a'),
  value('a1x', 'Alpha 1 X', 'a1'),
];

describe('buildDimensionRows', () => {
  it('lists parents before their children, siblings by name, with the depth', () => {
    expect(buildDimensionRows(values).map((r) => `${r.depth}:${r.value.name}`)).toEqual([
      '0:Alpha',
      '1:Alpha 1',
      '2:Alpha 1 X',
      '1:Alpha 2',
      '0:Beta',
    ]);
  });

  it('shows a value at the top level when its parent is not in the list', () => {
    const rows = buildDimensionRows(values.filter((v) => v.id !== 'a'));
    expect(rows.map((r) => `${r.depth}:${r.value.name}`)).toEqual(['0:Alpha 1', '1:Alpha 1 X', '0:Alpha 2', '0:Beta']);
  });

  it('survives a circular hierarchy without looping', () => {
    const rows = buildDimensionRows([value('x', 'X', 'y'), value('y', 'Y', 'x')]);
    // Nothing is reachable from the top level, so nothing is listed rather than looping forever.
    expect(rows.length).toBeLessThanOrEqual(2);
  });
});

describe('descendantIds', () => {
  it('finds children at any depth', () => {
    expect(descendantIds(values, 'a').sort()).toEqual(['a1', 'a1x', 'a2']);
    expect(descendantIds(values, 'a1x')).toEqual([]);
    expect(descendantIds(values, 'b')).toEqual([]);
  });
});
