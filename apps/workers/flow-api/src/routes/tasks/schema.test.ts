import { describe, it, expect } from 'vitest';
import {
  createTaskSchema,
  normalizeTaskStatus,
  taskStatusAliases,
  updateTaskSchema,
} from '@weldsuite/app-api-client/schemas/tasks';

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

  it('stores the legacy in_review status as review and leaves other statuses alone', () => {
    expect(updateTaskSchema.parse({ status: 'in_review' })).toEqual({ status: 'review' });
    expect(createTaskSchema.parse({ title: 't', status: 'in_review' })).toMatchObject({ status: 'review' });
    expect(updateTaskSchema.parse({ status: 'blocked_3a8y' })).toEqual({ status: 'blocked_3a8y' });
  });
});

describe('task status helpers', () => {
  it('normalizeTaskStatus maps only legacy spellings', () => {
    expect(normalizeTaskStatus('in_review')).toBe('review');
    expect(normalizeTaskStatus('review')).toBe('review');
    expect(normalizeTaskStatus('done')).toBe('done');
    expect(normalizeTaskStatus(null)).toBeNull();
    expect(normalizeTaskStatus(undefined)).toBeUndefined();
  });

  it('taskStatusAliases lists every stored spelling of a status', () => {
    expect(taskStatusAliases('review')).toEqual(['review', 'in_review']);
    expect(taskStatusAliases('in_review')).toEqual(['review', 'in_review']);
    expect(taskStatusAliases('todo')).toEqual(['todo']);
  });
});
