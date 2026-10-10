import { describe, it, expect } from 'vitest';
import { updateTaskSchema } from '@weldsuite/app-api-client/schemas/tasks';

describe('updateTaskSchema', () => {
  it('strips server-owned and undeclared keys instead of passing them through', () => {
    expect(
      updateTaskSchema.parse({ id: 'x', number: 1, deletedAt: 'z', reporterId: 'r', title: 't' }),
    ).toEqual({ title: 't' });
  });

  it('keeps every allow-listed field and accepts a null assigneeIds', () => {
    const body = {
      title: 't',
      description: 'd',
      status: 'todo',
      priority: 'high',
      type: 'task',
      stageId: 's',
      sprintId: null,
      milestoneId: null,
      parentTaskId: 'p',
      assigneeId: 'u',
      assigneeIds: null,
      customerId: null,
      contactId: null,
      startDate: '2030-01-01T00:00:00.000Z',
      dueDate: '2030-01-02T00:00:00.000Z',
      estimatedHours: '2',
      duration: 30,
      storyPoints: 3,
      labels: ['a'],
      tags: ['b'],
      isBillable: false,
      repeat: { frequency: 'daily' as const },
      customFields: { k: 'v' },
      projectId: 'proj',
      dependsOn: ['d1'],
      blocks: ['b1'],
    };
    expect(updateTaskSchema.parse(body)).toEqual(body);
  });

  it('accepts a null duration, which clears it, and rejects a non-number', () => {
    expect(updateTaskSchema.parse({ duration: null })).toEqual({ duration: null });
    expect(updateTaskSchema.parse({})).toEqual({});
    expect(updateTaskSchema.safeParse({ duration: '30' }).success).toBe(false);
  });
});
