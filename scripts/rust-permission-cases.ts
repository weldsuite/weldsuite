/**
 * Parity cases for the Rust permissions engine (`rust/crates/permissions`):
 * the TypeScript functions run over fixed inputs, and the Rust tests replay
 * the same inputs and expect the same answers. Written by
 * `pnpm rust:catalogs`, so a change to @weldsuite/permissions shows up as a
 * stale fixture in CI until the Rust port follows.
 *
 * Every table is a cross product in loop order (outer list first). To keep
 * the fixture small, the innermost list is packed into one string per row:
 * `y`/`n` per boolean, or the app-check results joined with a space.
 */
import { buildAppPermissionCatalog, hasObjectAccessInApp } from '../packages/core/permissions/src/app-catalog';
import { checkAppPermission, parsePermissionKey, qualifyPermission } from '../packages/core/permissions/src/app-scope';
import { normalizeAppCode } from '../packages/core/permissions/src/apps';
import { getRoleRowPermissions } from '../packages/core/permissions/src/catalog';
import { expandWildcards, hasObjectAccess, hasPermission } from '../packages/core/permissions/src/engine';
import { checkPermissionGrants, isGrantablePermissionKey } from '../packages/core/permissions/src/grants';
import { resolveEffectivePermissions, type PermissionDbQuery } from '../packages/core/permissions/src/server/resolver';

const GRANTS: string[][] = [
  [],
  ['*'],
  ['leads:*'],
  ['*:read'],
  ['*:*'],
  ['leads:read'],
  ['leads'],
  ['leads:read:extra'],
  ['companies:read'],
  ['companies:scope:all'],
  ['weldcrm:*'],
  ['weldcrm:*:read'],
  ['weldcrm:companies:read'],
  ['weldcrm:companies:*'],
  ['weldbooks:companies:read', 'weldcrm:people:update'],
  ['weldobjects:*'],
  ['weldobjects:machine:*'],
  ['team:read', 'billing:manage'],
];

const REQUIRED: string[] = [
  'leads:read',
  'leads:create',
  'leads',
  'companies:read',
  'companies:scope:all',
  'weldcrm:companies:read',
  'weldbooks:companies:read',
  'people:update',
  'products:read',
  'team:read',
  'billing:manage',
  'weldagent:use',
  'weldobjects:read',
  'weldobjects:machine:read',
];

const OBJECTS = ['leads', 'companies', 'people', 'team', 'weldobjects', 'billing', 'nothing'];

const APPS: (string | null)[] = [null, 'weldcrm', 'weldbooks', ' CRM ', 'weldhost', 'unknown', ''];

const DENIES: (string[] | undefined)[] = [undefined, ['companies:read'], ['weldcrm:*'], ['*']];

const KEYS = [
  'leads:read',
  'companies:scope:all',
  'weldcrm:companies:read',
  'weldbooks:companies:read',
  'weldhost:companies:read',
  'weldcrm:leads',
  'weldagent:use',
  'weldobjects:read',
  'weldobjects:machine:read',
  'weldchat:messages:read',
  'projects:read',
  'weldflow:projects:read',
  'team:read',
];

const NORMALIZE_INPUTS = ['weldcrm', 'CRM', ' parcel ', 'WeldStash', 'unknown', '', '﻿desk'];

const GRANTABLE_KEYS = [
  ...KEYS,
  '', '*', '*:read', 'leads:*', 'weldcrm:*', 'weldcrm:companies:*', 'weldcrm:nothing:*', 'nothing:*',
  'leads:read ', 'Leads:Read', 'leads::read', 'weldobjects:anything:read', 'weldobjects:x', 'x'.repeat(201),
  'employees:self', 'nope:read',
];

/**
 * One `checkAppPermission` result: `y`/`n` (allowed), the mode (`w`
 * workspace, `a` app, `x` any-app), `:<app>` in app mode, and `!` when the
 * object is not in the requested app. `ya:weldcrm`, `nx!`.
 */
function appCheckResult(check: ReturnType<typeof checkAppPermission>): string {
  const mode = { workspace: 'w', app: 'a', 'any-app': 'x' }[check.mode];
  return `${check.allowed ? 'y' : 'n'}${mode}${check.app ? `:${check.app}` : ''}${check.objectNotInApp ? '!' : ''}`;
}

/** One `y`/`n` per boolean. */
function flags(values: boolean[]): string {
  return values.map((v) => (v ? 'y' : 'n')).join('');
}

function cross<A, B>(as: readonly A[], bs: readonly B[]): [A, B][] {
  return as.flatMap((a) => bs.map((b): [A, B] => [a, b]));
}

const SAMPLE_CATALOG = buildAppPermissionCatalog().apps
  .flatMap((app) => app.objects.flatMap((o) => o.permissions.map((p) => p.key)))
  .filter((key) => key.startsWith('weldcrm:companies:') || key.startsWith('weldcrm:leads:'));

/** Member rows, roles and teams the resolver cases read. */
const RESOLVE_DB = {
  members: {
    user_owner: { id: 'mem_owner', role: 'OWNER', roleId: 'role_x', permissions: ['leads:read'], permissionDenies: ['*'] },
    user_admin: { id: 'mem_admin', role: 'ADMIN', roleId: null, permissions: null },
    user_custom: {
      id: 'mem_custom',
      role: 'MEMBER',
      roleId: 'role_sales',
      permissions: ['weldcrm:quotes:read', 'leads:read'],
      permissionDenies: ['weldcrm:leads:delete'],
    },
    user_missing_role: { id: 'mem_missing', role: 'MEMBER', roleId: 'role_gone', permissions: ['team:read'] },
    user_unknown_role: { id: 'mem_unknown', role: 'AUDITOR', roleId: null, permissions: null },
    user_employee: {
      id: 'mem_employee',
      role: 'ADMIN',
      roleId: 'role_sales',
      permissions: ['billing:manage'],
      permissionDenies: ['weldchat:messages:delete'],
      memberType: 'EMPLOYEE',
    },
  } as Record<string, Awaited<ReturnType<PermissionDbQuery['getMember']>>>,
  roles: { role_sales: ['leads:*', 'weldcrm:companies:read', 'leads:read'] } as Record<string, string[]>,
  teams: {
    mem_custom: [['weldcrm:companies:read', 'team:read'], ['weldbooks:invoices:read']],
    mem_admin: [['weldpass:secrets:read']],
  } as Record<string, string[][]>,
};

async function resolveCases() {
  const queries: PermissionDbQuery = {
    getMember: async (userId) => RESOLVE_DB.members[userId] ?? null,
    getRolePermissions: async (roleId) => RESOLVE_DB.roles[roleId] ?? null,
    getTeamPermissions: async (memberId) => RESOLVE_DB.teams[memberId] ?? [],
  };
  const users = [...Object.keys(RESOLVE_DB.members), 'user_nobody'];
  const results = [];
  for (const userId of users) results.push(await resolveEffectivePermissions(queries, userId));
  return { db: RESOLVE_DB, users, results };
}

export async function buildPermissionCases(): Promise<unknown> {
  const grantors = [GRANTS[2]!, GRANTS[10]!, ['weldcrm:*', 'leads:read'], ['*']].map((permissions, i) => ({
    permissions,
    ...(i === 2 ? { denies: ['weldcrm:leads:delete'] } : {}),
  }));
  const requested: string[][] = [
    ['leads:read', 'leads:*'],
    ['weldcrm:leads:read', 'weldcrm:leads:delete', 'weldcrm:*'],
    ['*', '*:read', 'nope:read', 'leads:read', 'leads:read'],
    ['weldobjects:machine:read', 'weldobjects:*', 'Leads:Read', 'bad key'],
  ];
  const roleRows = [
    { isSystem: true, name: 'admin', permissions: ['leads:read'] },
    { isSystem: true, name: 'Custom', permissions: ['leads:read'] },
    { isSystem: false, name: 'VIEWER', permissions: ['leads:read'] },
    { isSystem: false, name: 'Sales', permissions: null },
  ];

  return {
    grants: GRANTS,
    required: REQUIRED,
    hasPermission: GRANTS.map((g) => flags(REQUIRED.map((r) => hasPermission(g, r)))),
    objects: OBJECTS,
    hasObjectAccess: GRANTS.map((g) => flags(OBJECTS.map((o) => hasObjectAccess(g, o)))),
    expandCatalog: SAMPLE_CATALOG,
    expandWildcards: GRANTS.map((g) => expandWildcards(g, SAMPLE_CATALOG)),

    keys: KEYS,
    parse: KEYS.map((key) => parsePermissionKey(key)),
    qualify: cross(KEYS, ['weldcrm', 'weldhost']).map(([k, a]) => qualifyPermission(k, a)),
    normalizeInputs: NORMALIZE_INPUTS,
    normalize: NORMALIZE_INPUTS.map((code) => normalizeAppCode(code)),

    apps: APPS,
    denies: DENIES,
    appCheck: GRANTS.flatMap((permissions) =>
      DENIES.flatMap((denies) =>
        REQUIRED.map((r) => APPS.map((a) => appCheckResult(checkAppPermission({ permissions, denies }, r, a))).join(' ')),
      ),
    ),
    objectAccessInApp: GRANTS.flatMap((permissions) =>
      DENIES.flatMap((denies) =>
        OBJECTS.map((o) => flags(APPS.map((a) => hasObjectAccessInApp({ permissions, denies }, o, a)))),
      ),
    ),

    grantableKeys: GRANTABLE_KEYS,
    grantable: flags(GRANTABLE_KEYS.map((key) => isGrantablePermissionKey(key))),
    grantors,
    requested,
    alreadyGranted: [[], ['leads:*', 'bad key']],
    grantChecks: grantors.flatMap((grantor) =>
      requested.flatMap((req) => [[], ['leads:*', 'bad key']].map((already) => checkPermissionGrants(grantor, req, already))),
    ),

    roleRows,
    roleRowPermissions: roleRows.map((row) => getRoleRowPermissions(row)),
    resolve: await resolveCases(),
  };
}

