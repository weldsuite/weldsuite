import { describe, expect, it } from 'vitest';
import {
  assignableEntityRoles,
  availableMembersToAdd,
  filterMembersByQuery,
  removingHidesFromSelf,
  restrictingHidesFromSelf,
} from './access-members';

const member = (userId: string, extra: Record<string, string> = {}) => ({
  userId,
  name: `Name ${userId}`,
  email: `${userId}@example.com`,
  status: 'ACTIVE',
  memberType: 'INTERNAL',
  ...extra,
});

describe('availableMembersToAdd', () => {
  it('drops employees, guests, pending invites and members that are already listed', () => {
    const result = availableMembersToAdd(
      [
        member('a'),
        member('b', { memberType: 'EMPLOYEE' }),
        member('c', { memberType: 'EXTERNAL_GUEST' }),
        member('d', { status: 'PENDING' }),
        member('e'),
      ],
      [{ userId: 'e' }],
    );
    expect(result.map((m) => m.userId)).toEqual(['a']);
  });

  it('keeps members without a memberType or status', () => {
    const result = availableMembersToAdd([{ userId: 'x', name: 'X' }], []);
    expect(result).toHaveLength(1);
  });
});

describe('filterMembersByQuery', () => {
  it('matches name or email, ignoring case', () => {
    const list = [member('anna'), member('bob')];
    expect(filterMembersByQuery(list, 'ANNA').map((m) => m.userId)).toEqual(['anna']);
    expect(filterMembersByQuery(list, 'bob@').map((m) => m.userId)).toEqual(['bob']);
    expect(filterMembersByQuery(list, '  ')).toHaveLength(2);
  });
});

describe('assignableEntityRoles', () => {
  it('excludes the system Owner role only', () => {
    const roles = [
      { id: 'r1', name: 'Owner', isSystemRole: true },
      { id: 'r2', name: 'Admin', isSystemRole: true },
      { id: 'r3', name: 'Owner', isSystemRole: false },
    ];
    expect(assignableEntityRoles(roles).map((r) => r.id)).toEqual(['r2', 'r3']);
  });
});

describe('restrictingHidesFromSelf', () => {
  it('warns an admin who is not listed, not one who is, nor an owner', () => {
    const members = [{ userId: 'u_listed' }];
    expect(restrictingHidesFromSelf({ userId: 'u_admin', isOwner: false, members })).toBe(true);
    expect(restrictingHidesFromSelf({ userId: 'u_listed', isOwner: false, members })).toBe(false);
    expect(restrictingHidesFromSelf({ userId: 'u_owner', isOwner: true, members })).toBe(false);
    expect(restrictingHidesFromSelf({ userId: null, isOwner: false, members })).toBe(true);
  });
});

describe('removingHidesFromSelf', () => {
  it('only warns when a non-owner takes themselves off a restricted entity', () => {
    const me = { userId: 'u_admin', isOwner: false };
    expect(removingHidesFromSelf(me, true, 'u_admin')).toBe(true);
    expect(removingHidesFromSelf(me, false, 'u_admin')).toBe(false);
    expect(removingHidesFromSelf(me, true, 'u_other')).toBe(false);
    expect(removingHidesFromSelf({ userId: 'u_owner', isOwner: true }, true, 'u_owner')).toBe(false);
  });
});
