import { describe, expect, it } from 'vitest';
import { assigneeIdsInvolved, buildTaskChanges } from './task-changes';

const existing = {
  title: 'Ship it',
  description: '<p>old</p>',
  status: 'todo',
  priority: 'medium',
  dueDate: new Date('2030-01-01T00:00:00.000Z'),
  estimatedHours: '2.00',
  repeat: null,
  assigneeId: 'u1',
  assigneeIds: ['u1'],
  stageId: 's1',
};

describe('buildTaskChanges', () => {
  it('reports old and new values for changed fields only', () => {
    expect(
      buildTaskChanges(existing, { status: 'in_progress', priority: 'medium', title: 'Ship it' }),
    ).toEqual({ status: { old: 'todo', new: 'in_progress' } });
  });

  it('records a repeat being set', () => {
    expect(buildTaskChanges(existing, { repeat: { frequency: 'weekly' } })).toEqual({
      repeat: { old: null, new: { frequency: 'weekly' } },
    });
  });

  it('compares dates and numeric strings by value', () => {
    expect(
      buildTaskChanges(existing, { dueDate: new Date('2030-01-01T00:00:00.000Z'), estimatedHours: '2' }),
    ).toBeNull();
    expect(buildTaskChanges(existing, { dueDate: null })).toEqual({
      dueDate: { old: '2030-01-01T00:00:00.000Z', new: null },
    });
  });

  it('shows a plain-text excerpt for description edits', () => {
    expect(buildTaskChanges(existing, { description: '<p>new <b>text</b></p>' })).toEqual({
      description: { old: 'old', new: 'new text' },
    });
  });

  it('names assignees and ignores a no-op reassignment', () => {
    const names = new Map([
      ['u1', 'Ann'],
      ['u2', 'Bob'],
    ]);
    expect(buildTaskChanges(existing, { assigneeIds: ['u2'], assigneeId: 'u2' }, names)).toEqual({
      assigneeName: { old: 'Ann', new: 'Bob' },
    });
    expect(buildTaskChanges(existing, { assigneeIds: ['u1'], assigneeId: 'u1' }, names)).toBeNull();
    expect(buildTaskChanges(existing, { assigneeIds: null, assigneeId: null }, names)).toEqual({
      assigneeName: { old: 'Ann', new: null },
    });
  });

  it('reports a stage-only move', () => {
    expect(buildTaskChanges(existing, { stageId: 's2' })).toEqual({ stageId: { old: 's1', new: 's2' } });
    expect(buildTaskChanges(existing, { status: 'done', stageId: 's2' })).toEqual({
      status: { old: 'todo', new: 'done' },
    });
  });

  it('returns null when nothing tracked changed', () => {
    expect(buildTaskChanges(existing, { title: 'Ship it' })).toBeNull();
  });
});

describe('assigneeIdsInvolved', () => {
  it('is empty when the update leaves assignees alone', () => {
    expect(assigneeIdsInvolved(existing, { title: 'x' })).toEqual([]);
  });
  it('lists previous and new assignees once', () => {
    expect(assigneeIdsInvolved(existing, { assigneeIds: ['u1', 'u2'], assigneeId: 'u1' }).sort()).toEqual([
      'u1',
      'u2',
    ]);
  });
});
