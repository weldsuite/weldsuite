import { describe, expect, it } from 'vitest';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import { buildEntityAccess, canSeeEntity, entityAccessSource, entityRoleId, visibleEntityIds } from './access';

const member: ResolvedPermissions = { permissions: ['invoices:read'], denies: [], role: 'MEMBER', roleId: null, isOwner: false };
const owner: ResolvedPermissions = { permissions: ['*'], denies: [], role: 'OWNER', roleId: null, isOwner: true };
const manager: ResolvedPermissions = { ...member, permissions: ['legal_entities:manage'] };

const rows = [
  { id: 'open', accessRestricted: false, isMember: false, memberRoleId: null },
  { id: 'restricted', accessRestricted: true, isMember: false, memberRoleId: null },
  { id: 'restricted_listed', accessRestricted: true, isMember: true, memberRoleId: null },
  { id: 'open_with_role', accessRestricted: false, isMember: true, memberRoleId: 'role_viewer' },
];

describe('buildEntityAccess', () => {
  it('hides a restricted entity from a member without a row', () => {
    const access = buildEntityAccess('u1', member, rows);
    expect(canSeeEntity(access, 'restricted')).toBe(false);
    expect(visibleEntityIds(access)).toEqual(['open', 'restricted_listed', 'open_with_role']);
    expect(access.uniform).toBe(false);
  });

  it('shows a restricted entity to a listed member, with their workspace role when the row has none', () => {
    const access = buildEntityAccess('u1', member, rows);
    expect(canSeeEntity(access, 'restricted_listed')).toBe(true);
    expect(entityRoleId(access, 'restricted_listed')).toBeNull();
    expect(entityAccessSource(access, 'restricted_listed')).toBe('member');
    expect(entityAccessSource(access, 'open')).toBe('open');
  });

  it('applies the row role in an open entity', () => {
    const access = buildEntityAccess('u1', member, rows);
    expect(entityRoleId(access, 'open_with_role')).toBe('role_viewer');
  });

  it('lets owners and access managers see everything with their workspace role', () => {
    for (const permissions of [owner, manager]) {
      const access = buildEntityAccess('u1', permissions, rows);
      expect(access.seesAll).toBe(true);
      expect(access.uniform).toBe(true);
      expect(visibleEntityIds(access)).toHaveLength(4);
      expect(entityRoleId(access, 'open_with_role')).toBeNull();
    }
    expect(entityAccessSource(buildEntityAccess('u1', owner, rows), 'open')).toBe('owner');
    expect(entityAccessSource(buildEntityAccess('u1', manager, rows), 'open')).toBe('manager');
  });

  it('honours a personal deny on legal_entities:manage', () => {
    const access = buildEntityAccess('u1', { ...manager, denies: ['legal_entities:manage'] }, rows);
    expect(access.seesAll).toBe(false);
    expect(canSeeEntity(access, 'restricted')).toBe(false);
  });

  it('is uniform when nothing is restricted and no entity role is set', () => {
    const access = buildEntityAccess('u1', member, [
      { id: 'a', accessRestricted: false, isMember: false, memberRoleId: null },
      { id: 'b', accessRestricted: false, isMember: true, memberRoleId: null },
    ]);
    expect(access.uniform).toBe(true);
  });

  it('never sees an unknown or deleted id', () => {
    const access = buildEntityAccess('u1', owner, rows);
    expect(canSeeEntity(access, 'gone')).toBe(false);
    expect(canSeeEntity(access, null)).toBe(false);
  });
});
