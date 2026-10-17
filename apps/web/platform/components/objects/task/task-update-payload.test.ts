import { describe, expect, it } from 'vitest';
import { buildTaskUpdatePayload } from './task-update-payload';

describe('buildTaskUpdatePayload', () => {
  it('sends a set due date as an ISO string', () => {
    const date = new Date('2026-03-04T10:00:00.000Z');
    expect(buildTaskUpdatePayload({ dueDate: date })).toEqual({ dueDate: '2026-03-04T10:00:00.000Z' });
  });

  it('sends an explicit null when the due date was cleared (and does not throw)', () => {
    const payload = buildTaskUpdatePayload({ dueDate: null });
    expect(payload).toHaveProperty('dueDate', null);
  });

  it('sends an explicit null when the start date was cleared', () => {
    expect(buildTaskUpdatePayload({ startDate: null })).toHaveProperty('startDate', null);
  });

  it('leaves dates out of the payload when the edit does not touch them', () => {
    const payload = buildTaskUpdatePayload({ title: 'Renamed' });
    expect(payload).toEqual({ title: 'Renamed' });
    expect('dueDate' in payload).toBe(false);
    expect('startDate' in payload).toBe(false);
  });

  it('sends null for a removed recurrence', () => {
    expect(buildTaskUpdatePayload({ repeat: null })).toHaveProperty('repeat', null);
  });

  it('linking a company clears the person and the other way round', () => {
    expect(buildTaskUpdatePayload({ linkedCompany: { id: 'c1', name: 'Acme' } })).toMatchObject({
      customerId: 'c1',
      personId: null,
    });
    expect(buildTaskUpdatePayload({ linkedPerson: { id: 'p1', name: 'Ada' } })).toMatchObject({
      personId: 'p1',
      customerId: null,
    });
  });

  it('unlinking only clears the side that was cleared', () => {
    const payload = buildTaskUpdatePayload({ linkedCompany: null });
    expect(payload).toHaveProperty('customerId', null);
    expect('personId' in payload).toBe(false);
  });

  it('an assignee list sets the first as primary assignee', () => {
    expect(
      buildTaskUpdatePayload({ assignees: [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }] }),
    ).toMatchObject({ assigneeIds: ['u1', 'u2'], assigneeId: 'u1' });
    expect(buildTaskUpdatePayload({ assignees: [] })).toMatchObject({ assigneeIds: [], assigneeId: null });
    expect(buildTaskUpdatePayload({ assignee: null })).toEqual({ assigneeId: null });
  });
});
