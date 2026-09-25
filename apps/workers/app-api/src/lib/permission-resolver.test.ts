/**
 * @weldsuite/permissions resolver — member denies.
 *
 * The resolver merges role + team + member grants and passes the member's
 * explicit denies through (a deny is applied at check time and always wins).
 * The Drizzle adapter only selects `permission_denies` when the schema
 * declares it, so it keeps working against a schema without the column.
 */

import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  createDrizzlePermissionQueries,
  resolveEffectivePermissions,
  type PermissionDbQuery,
} from '@weldsuite/permissions/server';
import { checkAppPermission } from '@weldsuite/permissions';
import { schema } from '../db';

function queries(member: Awaited<ReturnType<PermissionDbQuery['getMember']>>, role: string[] = []): PermissionDbQuery {
  return {
    getMember: async () => member,
    getRolePermissions: async () => role,
    getTeamPermissions: async () => [['welddesk:tickets:read']],
  };
}

describe('resolveEffectivePermissions', () => {
  it('merges grants and passes member denies through', async () => {
    const resolved = await resolveEffectivePermissions(
      queries(
        { id: 'wm_1', role: 'MEMBER', roleId: 'role_1', permissions: ['weldcrm:leads:read'], permissionDenies: ['weldcrm:companies:read'] },
        ['companies:read'],
      ),
      'user_1',
    );
    expect(resolved.permissions).toEqual(
      expect.arrayContaining(['companies:read', 'welddesk:tickets:read', 'weldcrm:leads:read']),
    );
    expect(resolved.denies).toEqual(['weldcrm:companies:read']);
    expect(checkAppPermission(resolved, 'companies:read', 'weldcrm').allowed).toBe(false);
    expect(checkAppPermission(resolved, 'companies:read', 'welddesk').allowed).toBe(true);
  });

  it('treats a missing denies column as no denies', async () => {
    const resolved = await resolveEffectivePermissions(
      queries({ id: 'wm_1', role: 'VIEWER', roleId: null, permissions: null }),
      'user_1',
    );
    expect(resolved.denies).toEqual([]);
    expect(resolved.permissions.length).toBeGreaterThan(0);
  });

  it('never restricts the owner', async () => {
    const resolved = await resolveEffectivePermissions(
      queries({ id: 'wm_1', role: 'OWNER', roleId: null, permissions: [], permissionDenies: ['companies:read'] }),
      'user_1',
    );
    expect(resolved).toMatchObject({ permissions: ['*'], denies: [], isOwner: true });
  });

  it('returns nothing for a non-member', async () => {
    const resolved = await resolveEffectivePermissions(queries(null), 'user_1');
    expect(resolved).toMatchObject({ permissions: [], denies: [], role: '' });
  });
});

describe('createDrizzlePermissionQueries', () => {
  /** Minimal Drizzle-shaped stub that records the selected columns. */
  function fakeDb(rows: unknown[]) {
    const selected: Record<string, unknown>[] = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => rows,
    };
    return {
      selected,
      db: {
        select: (columns: Record<string, unknown>) => {
          selected.push(columns);
          return chain;
        },
      },
    };
  }

  it('selects permission_denies when the schema declares it', async () => {
    const { db, selected } = fakeDb([{ id: 'wm_1', role: 'MEMBER', roleId: null, permissions: [], permissionDenies: ['x:read'] }]);
    const member = await createDrizzlePermissionQueries(db, schema, { eq, and, isNull }).getMember('user_1');
    expect(Object.keys(selected[0]!)).toContain('permissionDenies');
    expect(member?.permissionDenies).toEqual(['x:read']);
  });

  it('leaves the column out for a schema without it', async () => {
    const { permissionDenies: _omitted, ...legacyMembers } = schema.workspaceMembers as unknown as Record<string, unknown>;
    const { db, selected } = fakeDb([]);
    await createDrizzlePermissionQueries(db, { ...schema, workspaceMembers: legacyMembers }, { eq, and, isNull }).getMember('user_1');
    expect(Object.keys(selected[0]!)).not.toContain('permissionDenies');
  });
});
