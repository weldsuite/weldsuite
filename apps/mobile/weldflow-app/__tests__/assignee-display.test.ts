import { formatTaskAssigneeDisplay } from '@/lib/assignee-display';

describe('formatTaskAssigneeDisplay', () => {
  it('prefers enriched assignee name over raw user id', () => {
    const label = formatTaskAssigneeDisplay({
      assigneeId: 'user_3984pBydzNbnt1KVhOHY5fZYzqq',
      assignee: {
        id: 'user_3984pBydzNbnt1KVhOHY5fZYzqq',
        name: 'Alex Rivera',
        email: 'alex@example.com',
      },
    });
    expect(label).toBe('Alex Rivera');
  });

  it('joins multiple enriched assignee names', () => {
    const label = formatTaskAssigneeDisplay({
      assigneeIds: ['user_a', 'user_b'],
      assignees: [
        { id: 'user_a', name: 'Alex Rivera', email: 'alex@example.com' },
        { id: 'user_b', name: 'Sam Chen', email: 'sam@example.com' },
      ],
    });
    expect(label).toBe('Alex Rivera, Sam Chen');
  });

  it('falls back to email when name is missing', () => {
    const label = formatTaskAssigneeDisplay({
      assigneeId: 'user_1',
      assignee: { id: 'user_1', name: null, email: 'solo@example.com' },
    });
    expect(label).toBe('solo@example.com');
  });

  it('resolves ids via project members when enrichment is absent', () => {
    const label = formatTaskAssigneeDisplay(
      { assigneeId: 'user_3984pBydzNbnt1KVhOHY5fZYzqq' },
      [
        {
          userId: 'user_3984pBydzNbnt1KVhOHY5fZYzqq',
          user: { name: 'Alex Rivera', email: 'alex@example.com' },
        },
      ],
    );
    expect(label).toBe('Alex Rivera');
  });

  it('returns null when the task is unassigned', () => {
    expect(formatTaskAssigneeDisplay({})).toBeNull();
    expect(formatTaskAssigneeDisplay({ assigneeId: null, assigneeIds: [] })).toBeNull();
  });
});
