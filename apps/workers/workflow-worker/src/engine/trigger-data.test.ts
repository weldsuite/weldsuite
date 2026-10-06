import { describe, it, expect } from 'vitest';
import { buildTriggerData, type TriggerRunMeta } from './trigger-data';

const meta: TriggerRunMeta = {
  userId: 'user_1',
  workspaceId: 'org_1',
  workflowId: 'wf_1',
  workflowName: 'Welcome',
  executionId: 'wex_1',
  startedAt: new Date('2026-09-23T09:00:00.000Z'),
};

describe('buildTriggerData', () => {
  it('exposes the editor vocabulary for entity events on top of the raw payload', () => {
    const out = buildTriggerData(
      'entity_event',
      {
        eventType: 'person:updated',
        entityType: 'person',
        entityId: 'person_1',
        action: 'updated',
        data: { id: 'person_1', email: 'new@acme.test', firstName: 'Ada' },
        changes: { email: { old: 'old@acme.test', new: 'new@acme.test' } },
      },
      meta,
    );

    expect(out.entity).toBe('person');
    expect(out.event).toBe('updated');
    expect(out.recordId).toBe('person_1');
    expect(out.record).toEqual({ id: 'person_1', email: 'new@acme.test', firstName: 'Ada' });
    expect(out.previousRecord).toEqual({ id: 'person_1', email: 'old@acme.test', firstName: 'Ada' });
    // Raw keys stay available for templates written against them.
    expect(out.entityId).toBe('person_1');
    expect((out.data as Record<string, unknown>).email).toBe('new@acme.test');
    expect(out.executionId).toBe('wex_1');
    expect(out.triggerType).toBe('entity_event');
  });

  it('omits previousRecord when the event carries no changes', () => {
    const out = buildTriggerData(
      'entity_event',
      { entityType: 'company', entityId: 'company_1', action: 'created', data: { id: 'company_1' } },
      meta,
    );
    expect(out).not.toHaveProperty('previousRecord');
    expect(out.record).toEqual({ id: 'company_1' });
  });

  it('adds scheduledTime and runId for schedule runs', () => {
    const out = buildTriggerData('schedule', { scheduleId: 'sched_1', cronExpression: '0 9 * * *' }, meta);
    expect(out.scheduledTime).toBe('2026-09-23T09:00:00.000Z');
    expect(out.runId).toBe('wex_1');
    expect(out.scheduleId).toBe('sched_1');
  });

  it('uses the due slot, not the start instant, for scheduledTime and formats the local time', () => {
    const late = { ...meta, startedAt: new Date('2026-10-05T20:44:20.878Z') };
    const out = buildTriggerData(
      'schedule',
      { scheduleId: 's', scheduledTime: '2026-10-05T20:44:00.000Z', timezone: 'Europe/Amsterdam' },
      late,
    );
    expect(out.scheduledTime).toBe('2026-10-05T20:44:00.000Z');
    expect(out.scheduledTimeLocal).toBe('2026-10-05 22:44');
  });

  it('floors to the minute when the sweep sent no slot, and defaults the zone to UTC', () => {
    const late = { ...meta, startedAt: new Date('2026-10-05T20:44:20.878Z') };
    const out = buildTriggerData('schedule', { scheduleId: 's' }, late);
    expect(out.scheduledTime).toBe('2026-10-05T20:44:00.000Z');
    expect(out.scheduledTimeLocal).toBe('2026-10-05 20:44');
  });

  it('floors a raw slot that is not minute-aligned in the alias and keeps the raw key winning', () => {
    const out = buildTriggerData(
      'schedule',
      { scheduledTime: '2026-10-05T20:44:30.500Z', timezone: 'America/New_York' },
      meta,
    );
    // raw payload key wins over the alias (as for every other trigger type)
    expect(out.scheduledTime).toBe('2026-10-05T20:44:30.500Z');
    expect(out.scheduledTimeLocal).toBe('2026-10-05 16:44');
  });

  it('falls back to UTC for an unknown timezone and rolls the date over at midnight', () => {
    const out = buildTriggerData(
      'schedule',
      { scheduledTime: '2026-12-31T23:30:00.000Z', timezone: 'Mars/Olympus' },
      meta,
    );
    expect(out.scheduledTimeLocal).toBe('2026-12-31 23:30');
    const tokyo = buildTriggerData(
      'schedule',
      { scheduledTime: '2026-12-31T23:30:00.000Z', timezone: 'Asia/Tokyo' },
      meta,
    );
    expect(tokyo.scheduledTimeLocal).toBe('2027-01-01 08:30');
  });

  it('wraps a non-object payload under data', () => {
    const out = buildTriggerData('manual', 'hello', meta);
    expect(out.data).toBe('hello');
    expect(out.timestamp).toBe('2026-09-23T09:00:00.000Z');
    expect(out.userId).toBe('user_1');
  });
});
