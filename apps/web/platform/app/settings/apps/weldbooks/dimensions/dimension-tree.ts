import type { DimensionValue } from '@/lib/api/domains/weldbooks';

export interface DimensionTreeRow {
  value: DimensionValue;
  depth: number;
}

function byName(a: DimensionValue, b: DimensionValue): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * The values as a depth-first list: parents before their children, siblings by
 * name. A value whose parent is missing from the list (filtered out, or
 * deleted) is shown at the top level so it never disappears.
 */
export function buildDimensionRows(values: readonly DimensionValue[]): DimensionTreeRow[] {
  const ids = new Set(values.map((v) => v.id));
  const children = new Map<string | null, DimensionValue[]>();
  for (const value of values) {
    const parent = value.parentId && ids.has(value.parentId) ? value.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), value]);
  }
  const rows: DimensionTreeRow[] = [];
  const visit = (parentId: string | null, depth: number, seen: Set<string>) => {
    for (const value of [...(children.get(parentId) ?? [])].sort(byName)) {
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      rows.push({ value, depth });
      visit(value.id, depth + 1, seen);
    }
  };
  visit(null, 0, new Set());
  return rows;
}

/** Ids of every value below `id`, at any depth. */
export function descendantIds(values: readonly DimensionValue[], id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const value of values) {
      if (value.parentId === current && !seen.has(value.id)) {
        seen.add(value.id);
        out.push(value.id);
        queue.push(value.id);
      }
    }
  }
  return out;
}
