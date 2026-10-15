import { PERMISSION_APPS, PERMISSION_CATALOG_OBJECTS } from '@weldsuite/permissions';
import { BUILTIN_GRANTS } from '../agent-state';

export interface AccessAction {
  /** Permission key, e.g. "tickets:create". */
  key: string;
  /** The part after the object, e.g. "create" or "scope:all". */
  action: string;
}

export interface AccessObject {
  key: string;
  label: string;
  actions: AccessAction[];
}

export interface AccessGroup {
  /** App code, or "workspace" for objects no app owns. */
  id: string;
  label: string | null;
  objects: AccessObject[];
}

const BUILTIN_KEYS = new Set<string>(Object.values(BUILTIN_GRANTS));

/**
 * The grantable workspace permissions as one group per app, each object with
 * the actions an agent may be given. The sandbox and web grants are left out:
 * they have their own switches.
 */
export function buildAccessGroups(grantable: string[]): AccessGroup[] {
  const available = new Set(grantable.filter((key) => !BUILTIN_KEYS.has(key)));
  const placed = new Set<string>();
  const objects = new Map<string, AccessObject>();

  for (const object of PERMISSION_CATALOG_OBJECTS) {
    const actions = object.permissions
      .filter((p) => available.has(p.key))
      .map((p) => ({ key: p.key, action: p.key.slice(object.key.length + 1) }));
    if (actions.length === 0) continue;
    actions.forEach((a) => placed.add(a.key));
    objects.set(object.key, { key: object.key, label: object.label, actions });
  }

  // Keys the catalog doesn't describe (e.g. custom objects) still get a row.
  for (const key of available) {
    if (placed.has(key)) continue;
    const split = key.indexOf(':');
    if (split < 0) continue;
    const objectKey = key.slice(0, split);
    const entry = objects.get(objectKey) ?? { key: objectKey, label: objectKey, actions: [] };
    entry.actions.push({ key, action: key.slice(split + 1) });
    objects.set(objectKey, entry);
  }

  const groups: AccessGroup[] = [];
  const owned = new Set<string>();
  for (const app of PERMISSION_APPS) {
    const appObjects = app.objects
      .filter((key) => !owned.has(key))
      .map((key) => objects.get(key))
      .filter((o): o is AccessObject => !!o);
    if (appObjects.length === 0) continue;
    appObjects.forEach((o) => owned.add(o.key));
    groups.push({ id: app.code, label: app.label, objects: appObjects });
  }

  const rest = [...objects.values()].filter((o) => !owned.has(o.key));
  if (rest.length > 0) groups.push({ id: 'workspace', label: null, objects: rest });
  return groups;
}

/** A group's permissions an agent holds, counting wildcards like "tickets:*" and "*". */
export function grantedIn(keys: string[], permissions: Set<string>): string[] {
  return keys.filter((key) => holds(permissions, key));
}

export function holds(permissions: Set<string>, key: string): boolean {
  if (permissions.has(key) || permissions.has('*')) return true;
  const object = key.slice(0, key.indexOf(':'));
  return permissions.has(`${object}:*`);
}
