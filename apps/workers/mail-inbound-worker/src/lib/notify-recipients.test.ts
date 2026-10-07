/**
 * Who is pinged about new mail must match who may open the mailbox
 * (`hasAccessToAccount` in `@weldsuite/mail-domain/access`).
 */
import { describe, expect, it } from 'vitest';

import { selectNotifyMembers } from './notify-recipients';

const owner = { userId: 'user_owner', email: 'owner@test.dev', role: 'OWNER' };
const admin = { userId: 'user_admin', email: 'admin@test.dev', role: 'admin' };
const assignee = { userId: 'user_assignee', email: 'assignee@test.dev', role: 'MEMBER' };
const member = { userId: 'user_member', email: 'member@test.dev', role: 'MEMBER' };
const viewer = { userId: 'user_viewer', email: null, role: null };
const everyone = [owner, admin, assignee, member, viewer];

const ids = (members: { userId: string }[]) => members.map((m) => m.userId);

describe('selectNotifyMembers', () => {
  it('notifies every member of a shared mailbox', () => {
    expect(selectNotifyMembers({ isShared: true, assignedUserIds: null }, everyone)).toEqual(everyone);
    // Assignments are ignored while the mailbox is shared.
    expect(
      selectNotifyMembers({ isShared: true, assignedUserIds: [assignee.userId] }, everyone),
    ).toEqual(everyone);
  });

  it('notifies only the assignees of a private mailbox, not admins or owners', () => {
    const notified = selectNotifyMembers(
      { isShared: false, assignedUserIds: [assignee.userId] },
      everyone,
    );
    expect(ids(notified)).toEqual([assignee.userId]);
  });

  it('includes an admin who is assigned', () => {
    const notified = selectNotifyMembers(
      { isShared: false, assignedUserIds: [assignee.userId, admin.userId] },
      everyone,
    );
    expect(ids(notified)).toEqual([admin.userId, assignee.userId]);
  });

  it.each([
    ['an empty list', [] as string[]],
    ['null', null],
  ])('falls back to admins and owners when assignedUserIds is %s', (_label, assignedUserIds) => {
    const notified = selectNotifyMembers({ isShared: false, assignedUserIds }, everyone);
    expect(ids(notified)).toEqual([owner.userId, admin.userId]);
  });

  it('treats a null isShared as private', () => {
    const notified = selectNotifyMembers({ isShared: null, assignedUserIds: null }, everyone);
    expect(ids(notified)).toEqual([owner.userId, admin.userId]);
  });

  it('returns nobody when no assignee is an active member', () => {
    // The caller still stores the mail: an empty list is "no ping", not "no mailbox".
    expect(
      selectNotifyMembers({ isShared: false, assignedUserIds: ['user_deactivated'] }, everyone),
    ).toEqual([]);
  });
});
