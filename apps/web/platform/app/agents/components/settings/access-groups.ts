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
 * Several apps list the same object (`tasks` is in WeldCRM, WeldFlow, WeldChat
 * and more). The access list shows an object once, under the app it belongs
 * to: this names that app where it is not the first one that lists it.
 */
export const OBJECT_HOME_APP: Readonly<Record<string, string>> = {
  tasks: 'weldflow',
  files: 'weldflow',
  workflows: 'weldconnect',
  integrations: 'weldconnect',
  channels: 'weldchat',
  messages: 'weldchat',
  telephony: 'weldcall',
  calendars: 'weldcalendar',
  events: 'weldcalendar',
  domains: 'weldhost',
  inventory: 'weldstash',
};

/** The app each object is shown under: its entry in OBJECT_HOME_APP, else the first app that lists it. */
function homeAppByObject(): Map<string, string> {
  const home = new Map<string, string>();
  for (const app of PERMISSION_APPS) {
    for (const object of app.objects) if (!home.has(object)) home.set(object, app.code);
  }
  for (const [object, code] of Object.entries(OBJECT_HOME_APP)) {
    const app = PERMISSION_APPS.find((a) => a.code === code);
    if (app?.objects.includes(object)) home.set(object, code);
  }
  return home;
}

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

  const home = homeAppByObject();
  const groups: AccessGroup[] = [];
  const owned = new Set<string>();
  for (const app of PERMISSION_APPS) {
    const appObjects = app.objects
      .filter((key) => home.get(key) === app.code)
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

/** A tool as the catalog lists it. */
export interface ToolRequirement {
  requiredPermissions: string[];
}

/** `toolPermissions` of an agent detail response (absent on older responses). */
export function readToolPermissions(agent: object): string[] | undefined {
  const value = (agent as { toolPermissions?: unknown }).toolPermissions;
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : undefined;
}

/**
 * Every permission some agent tool needs, from the agent's own list and the
 * tool catalog. Null when neither says anything (the usage is then unknown and
 * the Access tab shows every grant as it always did).
 */
export function toolPermissionKeys(
  fromAgent: string[] | undefined,
  catalog: ToolRequirement[] | undefined,
): Set<string> | null {
  const keys = new Set<string>(fromAgent ?? []);
  for (const tool of catalog ?? []) {
    for (const key of tool.requiredPermissions) if (!BUILTIN_KEYS.has(key)) keys.add(key);
  }
  return keys.size > 0 ? keys : null;
}

export interface UsageSplit {
  /** Objects at least one agent tool uses an action of. */
  used: AccessGroup[];
  /** Objects no tool uses yet. */
  unused: AccessGroup[];
}

/** Splits the groups' objects by whether any agent tool needs one of their permissions. */
export function splitByToolUsage(groups: AccessGroup[], toolKeys: ReadonlySet<string> | null): UsageSplit {
  if (!toolKeys) return { used: groups, unused: [] };
  const used: AccessGroup[] = [];
  const unused: AccessGroup[] = [];
  for (const group of groups) {
    const inUse = group.objects.filter((o) => o.actions.some((a) => toolKeys.has(a.key)));
    const idle = group.objects.filter((o) => !o.actions.some((a) => toolKeys.has(a.key)));
    if (inUse.length > 0) used.push({ ...group, objects: inUse });
    if (idle.length > 0) unused.push({ ...group, objects: idle });
  }
  return { used, unused };
}

/**
 * The WeldSuite data tools the held permissions unlock: tools that need at
 * least one workspace permission, all of them held. Agent-internal tools (no
 * requirement) and the sandbox / web tools (their own switches) are not counted.
 */
export function countUnlockedTools(catalog: ToolRequirement[], permissions: Set<string>): number {
  return catalog.filter((tool) => {
    const needed = tool.requiredPermissions.filter((key) => !BUILTIN_KEYS.has(key));
    return needed.length > 0 && needed.every((key) => holds(permissions, key));
  }).length;
}

/** How many of the held permissions some agent tool uses. */
export function countUsedGrants(toolKeys: ReadonlySet<string>, permissions: Set<string>): number {
  return [...toolKeys].filter((key) => holds(permissions, key)).length;
}
