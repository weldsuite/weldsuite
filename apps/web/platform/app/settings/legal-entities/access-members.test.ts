import { describe, expect, it } from 'vitest';
import { assignableEntityRoles, availableMembersToAdd, filterMembersByQuery } from './access-members';

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
