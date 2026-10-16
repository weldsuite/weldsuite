import { describe, expect, it } from 'vitest';
import { orgRoleHasScopeAll, roomAccessFor } from './project-room-access';

describe('roomAccessFor (whiteboard room gate, TASK-772)', () => {
  const none = { scopeAll: false, isManager: false, memberRole: undefined };

  it('denies a workspace member who is not on the project', () => {
    expect(roomAccessFor(none)).toEqual({ canRead: false, canWrite: false });
  });

  it('lets owners and admins of the workspace (scope:all) in with write access', () => {
    expect(roomAccessFor({ ...none, scopeAll: true })).toEqual({ canRead: true, canWrite: true });
  });

  it('lets the project manager in even without a member row', () => {
    expect(roomAccessFor({ ...none, isManager: true })).toEqual({ canRead: true, canWrite: true });
  });

  it.each(['owner', 'admin', 'member', 'Member', 'OWNER'])('gives a %s member read + write', (role) => {
    expect(roomAccessFor({ ...none, memberRole: role })).toEqual({ canRead: true, canWrite: true });
  });

  it('lets a viewer watch but not edit', () => {
    expect(roomAccessFor({ ...none, memberRole: 'viewer' })).toEqual({ canRead: true, canWrite: false });
  });

  it('treats an unknown legacy role as read-only, like flow-api', () => {
    expect(roomAccessFor({ ...none, memberRole: 'contributor' })).toEqual({ canRead: true, canWrite: false });
  });
});

describe('orgRoleHasScopeAll', () => {
  it('only owners and admins hold projects:scope:all by default', () => {
    expect(orgRoleHasScopeAll('owner')).toBe(true);
    expect(orgRoleHasScopeAll('admin')).toBe(true);
    expect(orgRoleHasScopeAll('member')).toBe(false);
    expect(orgRoleHasScopeAll('viewer')).toBe(false);
  });
});
