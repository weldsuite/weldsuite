import { PERMISSION_APPS } from '@weldsuite/permissions';
import { describe, expect, it } from 'vitest';
import {
  OBJECT_HOME_APP,
  buildAccessGroups,
  countUnlockedTools,
  countUsedGrants,
  grantedIn,
  holds,
  readToolPermissions,
  splitByToolUsage,
  toolPermissionKeys,
} from './access-groups';

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

  it('shows tasks, projects and the other WeldFlow objects under WeldFlow, not WeldCRM', () => {
    const groups = buildAccessGroups([
      'tasks:read',
      'tasks:create',
      'projects:read',
      'milestones:read',
      'time:read',
      'files:read',
      'people:read',
    ]);
    const objectsOf = (id: string) => groups.find((g) => g.id === id)?.objects.map((o) => o.key) ?? [];
    expect(objectsOf('weldflow')).toEqual(expect.arrayContaining(['projects', 'tasks', 'milestones', 'time', 'files']));
    expect(objectsOf('weldcrm')).toEqual(['people']);
  });

  it('counts a granted task permission under WeldFlow only', () => {
    const groups = buildAccessGroups(['tasks:read', 'tasks:create', 'people:read', 'people:create']);
    const granted = new Set(['tasks:read', 'tasks:create']);
    const countOf = (id: string) =>
      grantedIn(
        (groups.find((g) => g.id === id)?.objects ?? []).flatMap((o) => o.actions.map((a) => a.key)),
        granted,
      ).length;
    expect(countOf('weldflow')).toBe(2);
    expect(countOf('weldcrm')).toBe(0);
  });
});

describe('OBJECT_HOME_APP', () => {
  it('only names apps that list the object', () => {
    for (const [object, code] of Object.entries(OBJECT_HOME_APP)) {
      const app = PERMISSION_APPS.find((a) => a.code === code);
      expect(app?.objects, `${code} lists ${object}`).toContain(object);
    }
  });
});

describe('holds', () => {
  it('honours object and global wildcards', () => {
    expect(holds(new Set(['tickets:*']), 'tickets:create')).toBe(true);
    expect(holds(new Set(['*']), 'people:read')).toBe(true);
    expect(holds(new Set(['tickets:read']), 'tickets:create')).toBe(false);
  });
});

describe('tool usage', () => {
  const catalog = [
    { requiredPermissions: [] },
    { requiredPermissions: ['people:read'] },
    { requiredPermissions: ['tasks:read'] },
    { requiredPermissions: ['tasks:create', 'projects:read'] },
    { requiredPermissions: ['browser:use'] },
  ];

  it('reads the tool permissions of an agent when the API sends them', () => {
    expect(readToolPermissions({ toolPermissions: ['people:read', 7, 'tasks:read'] })).toEqual(['people:read', 'tasks:read']);
    expect(readToolPermissions({})).toBeUndefined();
  });

  it('collects what tools need, without the sandbox and web grants', () => {
    expect([...(toolPermissionKeys(undefined, catalog) ?? [])].sort()).toEqual([
      'people:read',
      'projects:read',
      'tasks:create',
      'tasks:read',
    ]);
    expect([...(toolPermissionKeys(['leads:read'], undefined) ?? [])]).toEqual(['leads:read']);
    expect(toolPermissionKeys(undefined, undefined)).toBeNull();
    expect(toolPermissionKeys([], [])).toBeNull();
  });

  it('splits objects no tool uses from the ones some tool uses', () => {
    const groups = buildAccessGroups(['people:read', 'tasks:read', 'tasks:create', 'leads:read', 'tickets:read']);
    const { used, unused } = splitByToolUsage(groups, new Set(['people:read', 'tasks:read']));
    const keys = (list: typeof groups) => list.flatMap((g) => g.objects.map((o) => o.key)).sort();
    expect(keys(used)).toEqual(['people', 'tasks']);
    expect(keys(unused)).toEqual(['leads', 'tickets']);
  });

  it('keeps an object that has one used action together, with all its actions', () => {
    const groups = buildAccessGroups(['tasks:read', 'tasks:create']);
    const { used, unused } = splitByToolUsage(groups, new Set(['tasks:read']));
    expect(unused).toEqual([]);
    expect(used.flatMap((g) => g.objects).find((o) => o.key === 'tasks')?.actions).toHaveLength(2);
  });

  it('shows everything as used when nothing is known about the tools', () => {
    const groups = buildAccessGroups(['leads:read']);
    expect(splitByToolUsage(groups, null)).toEqual({ used: groups, unused: [] });
  });

  it('counts only data tools whose permissions are all held', () => {
    expect(countUnlockedTools(catalog, new Set())).toBe(0);
    expect(countUnlockedTools(catalog, new Set(['people:read']))).toBe(1);
    expect(countUnlockedTools(catalog, new Set(['tasks:*', 'projects:read']))).toBe(2);
    expect(countUnlockedTools(catalog, new Set(['*']))).toBe(3);
  });

  it('counts the held permissions a tool uses', () => {
    expect(countUsedGrants(new Set(['people:read', 'tasks:read']), new Set(['people:read', 'leads:read']))).toBe(1);
  });
});
