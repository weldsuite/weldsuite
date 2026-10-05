import { describe, expect, it } from 'vitest';
import { findDmChannelIdForUser, resolveOneToOneDmTarget } from './dm-links';

const me = 'user_me';

describe('resolveOneToOneDmTarget', () => {
  it('links a DM with someone else to that person', () => {
    const dm = { id: 'dm_1', otherMembers: [{ userId: 'user_ann' }] };
    expect(resolveOneToOneDmTarget(dm, dm.otherMembers, me)).toEqual({ key: 'user_ann', isSelf: false });
  });

  it('links a DM with yourself (no other member) to your own user id, not the channel id', () => {
    const dm = { id: 'dm_self', otherMembers: [] };
    expect(resolveOneToOneDmTarget(dm, [], me)).toEqual({ key: me, isSelf: true });
  });

  it('falls back to the channel id only while the signed-in user is still unknown', () => {
    const dm = { id: 'dm_self', otherMembers: [] };
    expect(resolveOneToOneDmTarget(dm, [], null)).toEqual({ key: 'dm_self', isSelf: true });
    expect(resolveOneToOneDmTarget(dm, [], undefined)).toEqual({ key: 'dm_self', isSelf: true });
  });
});

describe('findDmChannelIdForUser', () => {
  const dms = [
    { id: 'dm_ann', otherMembers: [{ userId: 'user_ann' }] },
    { id: 'dm_self', otherMembers: [] },
    { id: 'dm_group', otherMembers: [{ userId: 'user_ann' }, { userId: 'user_bob' }] },
  ];

  it('resolves another person to their DM', () => {
    expect(findDmChannelIdForUser(dms, 'user_ann', me)).toBe('dm_ann');
  });

  it('resolves your own id to the DM with yourself', () => {
    expect(findDmChannelIdForUser(dms, me, me)).toBe('dm_self');
  });

  it('returns null when there is no such conversation', () => {
    expect(findDmChannelIdForUser(dms, 'user_zed', me)).toBeNull();
    expect(findDmChannelIdForUser([{ id: 'dm_ann', otherMembers: [{ userId: 'user_ann' }] }], me, me)).toBeNull();
  });
});
