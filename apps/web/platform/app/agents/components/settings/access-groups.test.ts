import { describe, expect, it } from 'vitest';
import { buildAccessGroups, holds } from './access-groups';

describe('buildAccessGroups', () => {
  it('groups grantable keys by app and leaves the built-in grants out', () => {
    const groups = buildAccessGroups(['tickets:read', 'tickets:create', 'computer:use', 'browser:use']);
    const all = groups.flatMap((g) => g.objects.flatMap((o) => o.actions.map((a) => a.key)));
    expect(all.sort()).toEqual(['tickets:create', 'tickets:read']);
    const tickets = groups.flatMap((g) => g.objects).find((o) => o.key === 'tickets');
    expect(tickets?.actions.map((a) => a.action)).toEqual(['read', 'create']);
  });

  it('places each object in one group only', () => {
    const groups = buildAccessGroups(['people:read', 'tasks:read', 'tickets:read']);
    const keys = groups.flatMap((g) => g.objects.map((o) => o.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps keys the catalog does not know', () => {
    const groups = buildAccessGroups(['gizmos:read']);
    expect(groups).toEqual([
      { id: 'workspace', label: null, objects: [{ key: 'gizmos', label: 'gizmos', actions: [{ key: 'gizmos:read', action: 'read' }] }] },
    ]);
  });
});

describe('holds', () => {
  it('honours object and global wildcards', () => {
    expect(holds(new Set(['tickets:*']), 'tickets:create')).toBe(true);
    expect(holds(new Set(['*']), 'people:read')).toBe(true);
    expect(holds(new Set(['tickets:read']), 'tickets:create')).toBe(false);
  });
});
