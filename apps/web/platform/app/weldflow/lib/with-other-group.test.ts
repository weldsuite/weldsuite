import { describe, expect, it } from 'vitest';
import type { GroupConfig } from '@/components/entity-list';
import { withOtherGroup } from './with-other-group';

interface Row {
  status: string;
}

const groups: GroupConfig<Row>[] = [
  { id: 'todo', label: 'To do', sortOrder: 1, filter: (r) => r.status === 'todo' },
  { id: 'done', label: 'Done', sortOrder: 2, filter: (r) => r.status === 'done' },
];

describe('withOtherGroup', () => {
  it('collects the rows no other group matches', () => {
    const [, , other] = withOtherGroup(groups, 'Other');
    expect(other.id).toBe('other');
    expect(other.label).toBe('Other');
    expect(other.sortOrder).toBe(3);
    expect(other.filter({ status: 'backlog' })).toBe(true);
    expect(other.filter({ status: 'todo' })).toBe(false);
    expect(other.filter({ status: 'done' })).toBe(false);
  });

  it('leaves an ungrouped list alone', () => {
    expect(withOtherGroup([], 'Other')).toEqual([]);
  });
});
