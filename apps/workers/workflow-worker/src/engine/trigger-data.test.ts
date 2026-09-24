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

  it('wraps a non-object payload under data', () => {
    const out = buildTriggerData('manual', 'hello', meta);
    expect(out.data).toBe('hello');
    expect(out.timestamp).toBe('2026-09-23T09:00:00.000Z');
    expect(out.userId).toBe('user_1');
  });
});
