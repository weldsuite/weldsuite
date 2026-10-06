import { describe, expect, it } from 'vitest';
import { buildEntityAssigneeDirectory } from './entity-assignees';

describe('buildEntityAssigneeDirectory', () => {
  it('lists workspace members even when the customer has no tasks yet', () => {
    const directory = buildEntityAssigneeDirectory(
      [
        { userId: 'user_a', name: 'Ada Lovelace', email: 'ada@example.com', picture: 'https://img/ada' },
        { userId: 'user_b', name: 'Grace Hopper', email: 'grace@example.com' },
      ],
      [],
    );

    expect(directory.map((member) => member.userId)).toEqual(['user_a', 'user_b']);
    expect(directory[0]?.user).toEqual({
      id: 'user_a',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      avatar: 'https://img/ada',
    });
  });

  it('skips members that cannot be shown in the picker', () => {
    const directory = buildEntityAssigneeDirectory(
      [
        { userId: '', name: 'No id' },
        { userId: 'user_noname', name: '' },
        { userId: 'user_ok', name: 'Ok' },
      ],
      [],
    );

    expect(directory.map((member) => member.userId)).toEqual(['user_ok']);
  });

  it('keeps assignees who are no longer workspace members', () => {
    const directory = buildEntityAssigneeDirectory(
      [{ userId: 'user_a', name: 'Ada Lovelace' }],
      [
        {
          assignees: [{ id: 'user_left', name: 'Former Member', email: 'former@example.com' }],
          assigneeId: 'user_legacy',
          assignee: 'Legacy Name',
        },
      ],
    );

    expect(directory.map((member) => member.user.name)).toEqual([
      'Ada Lovelace',
      'Former Member',
      'Legacy Name',
    ]);
  });

  it('does not duplicate a member who is also assigned on a task', () => {
    const directory = buildEntityAssigneeDirectory(
      [{ userId: 'user_a', name: 'Ada Lovelace', picture: 'https://img/ada' }],
      [{ assignees: [{ id: 'user_a', name: 'Ada Lovelace' }] }],
    );

    expect(directory).toHaveLength(1);
    expect(directory[0]?.user.avatar).toBe('https://img/ada');
  });
});
