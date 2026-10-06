import { describe, it, expect } from 'vitest';
import {
  isSequenceWorkflow,
  isValidCronExpression,
  recurringScheduleTriggers,
  validateWeldConnectWorkflow,
} from './weldconnect-mvp';

const entityTrigger = { id: 'trigger-1', type: 'entity_event', entityType: 'person', eventType: 'created' };
const scheduleTrigger = {
  id: 'trigger-2',
  type: 'schedule',
  scheduleType: 'recurring',
  cronExpression: '0 9 * * 1-5',
  timezone: 'Europe/Amsterdam',
};
const emailStep = {
  id: 'step-1',
  type: 'send_email',
  config: { to: '{{trigger.record.email}}', subject: 'Welcome', body: '<p>Hi</p>' },
};
const customerStep = { id: 'step-2', type: 'create_customer', config: { name: '{{trigger.record.name}}' } };

describe('validateWeldConnectWorkflow', () => {
  it('accepts the MVP triggers and actions when fully configured', () => {
    expect(validateWeldConnectWorkflow({ triggers: [entityTrigger], steps: [emailStep, customerStep] })).toEqual([]);
    expect(validateWeldConnectWorkflow({ triggers: [scheduleTrigger], steps: [emailStep] })).toEqual([]);
  });

  it('reads schedule fields nested under config and treats a missing scheduleType as recurring', () => {
    const nested = { id: 't', type: 'schedule', config: { cronExpression: '*/15 * * * *' } };
    expect(validateWeldConnectWorkflow({ triggers: [nested], steps: [emailStep] })).toEqual([]);
  });

  it('requires an enabled trigger and at least one step', () => {
    const codes = validateWeldConnectWorkflow({
      triggers: [{ ...entityTrigger, isEnabled: false }],
      steps: [],
    }).map((i) => i.code);
    expect(codes).toEqual(['no_trigger', 'no_steps']);
  });

  it('rejects triggers and actions outside the MVP', () => {
    const issues = validateWeldConnectWorkflow({
      triggers: [{ id: 't', type: 'webhook' }],
      steps: [{ id: 's', type: 'http_request', config: { url: 'https://x' } }],
    });
    expect(issues).toEqual([
      { code: 'unsupported_trigger', triggerId: 't', type: 'webhook' },
      { code: 'unsupported_action', stepId: 's', type: 'http_request' },
    ]);
  });

  it('flags incomplete or unknown entity events', () => {
    expect(
      validateWeldConnectWorkflow({ triggers: [{ id: 't', type: 'entity_event', entityType: 'person' }], steps: [emailStep] }),
    ).toEqual([{ code: 'incomplete_entity_event', triggerId: 't' }]);
    expect(
      validateWeldConnectWorkflow({
        triggers: [{ id: 't', type: 'entity_event', entityType: 'person', eventType: 'exploded' }],
        steps: [emailStep],
      }),
    ).toEqual([{ code: 'unknown_entity_event', triggerId: 't' }]);
  });

  it('rejects one-time schedules, bad cron and bad timezones', () => {
    const codes = (trigger: Record<string, unknown>) =>
      validateWeldConnectWorkflow({ triggers: [trigger], steps: [emailStep] }).map((i) => i.code);
    expect(codes({ id: 't', type: 'schedule', scheduleType: 'one_time', executeAt: '2026-10-01T09:00' })).toEqual([
      'schedule_not_recurring',
    ]);
    expect(codes({ id: 't', type: 'schedule', cronExpression: '0 9 * *' })).toEqual(['invalid_cron']);
    expect(codes({ id: 't', type: 'schedule', cronExpression: '0 9 * * *', timezone: 'Mars/Olympus' })).toEqual([
      'invalid_timezone',
    ]);
  });

  it('reports each missing required field', () => {
    const issues = validateWeldConnectWorkflow({
      triggers: [entityTrigger],
      steps: [
        { id: 'a', type: 'send_email', config: { to: 'x@y.z', subject: '  ' } },
        { id: 'b', type: 'create_customer', config: {} },
      ],
    });
    expect(issues).toEqual([
      { code: 'missing_field', stepId: 'a', type: 'send_email', field: 'subject' },
      { code: 'missing_field', stepId: 'a', type: 'send_email', field: 'body' },
      { code: 'missing_field', stepId: 'b', type: 'create_customer', field: 'name' },
    ]);
  });
});

describe('validateWeldConnectWorkflow: logic steps', () => {
  const trigger = { id: 't', type: 'entity_event', entityType: 'customer', eventType: 'created' };
  const email = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'send_email',
    config: { to: 'a@b.co', subject: 's', body: 'b' },
    ...extra,
  });

  it('accepts a configured condition with steps in its branches, a loop with a body and a delay', () => {
    const issues = validateWeldConnectWorkflow({
      triggers: [trigger],
      steps: [
        { id: 'c', type: 'condition', config: { field: '{{trigger.data.status}}', operator: 'eq', value: 'won' } },
        email('yes', { parentBranchId: 'c_if' }),
        { id: 'l', type: 'loop', config: { items: '{{trigger.data.lines}}' } },
        email('each', { parentBranchId: 'l_each' }),
        { id: 'd', type: 'delay', config: { minutes: 5 } },
        { id: 'e', type: 'condition', config: { field: '{{trigger.data.note}}', operator: 'isEmpty' } },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('reports missing logic fields', () => {
    const issues = validateWeldConnectWorkflow({
      triggers: [trigger],
      steps: [
        { id: 'c', type: 'condition', config: { operator: 'eq' } },
        { id: 'l', type: 'loop', config: {} },
        email('each', { parentBranchId: 'l_each' }),
        { id: 'd', type: 'delay', config: { seconds: 0 } },
      ],
    });
    expect(issues).toEqual([
      { code: 'missing_field', stepId: 'c', type: 'condition', field: 'field' },
      { code: 'missing_field', stepId: 'c', type: 'condition', field: 'value' },
      { code: 'missing_field', stepId: 'l', type: 'loop', field: 'items' },
      { code: 'missing_field', stepId: 'd', type: 'delay', field: 'duration' },
    ]);
  });

  it('flags steps under a branch that does not exist and loops with nothing to repeat', () => {
    const issues = validateWeldConnectWorkflow({
      triggers: [trigger],
      steps: [email('lost', { parentBranchId: 'gone_if' }), { id: 'l', type: 'loop', config: { items: '[1]' } }],
    });
    expect(issues).toEqual([
      { code: 'orphan_step', stepId: 'lost', type: 'send_email' },
      { code: 'empty_loop', stepId: 'l', type: 'loop' },
    ]);
  });
});

describe('validateWeldConnectWorkflow: WeldSuite actions', () => {
  const trigger = { id: 't', type: 'schedule', cronExpression: '0 9 * * 1' };

  it('accepts configured contact and notification steps', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [
          { id: 'a', type: 'create_contact', config: { email: '{{trigger.data.email}}' } },
          { id: 'b', type: 'update_contact', config: { contactId: '{{steps.a.contactId}}', title: 'CTO' } },
          { id: 'c', type: 'send_notification', config: { title: 'New contact' } },
        ],
      }),
    ).toEqual([]);
  });

  it('reports their missing fields', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [
          { id: 'a', type: 'create_contact', config: { title: 'CTO' } },
          { id: 'b', type: 'update_contact', config: {} },
          { id: 'c', type: 'send_notification', config: {} },
        ],
      }),
    ).toEqual([
      { code: 'missing_field', stepId: 'a', type: 'create_contact', field: 'name' },
      { code: 'missing_field', stepId: 'b', type: 'update_contact', field: 'contactId' },
      { code: 'missing_field', stepId: 'c', type: 'send_notification', field: 'title' },
    ]);
  });
});

describe('isValidCronExpression', () => {
  it.each(['* * * * *', '*/5 * * * *', '0 9 * * 1-5', '0,30 8-17 1 1,6 0'])('accepts %s', (expr) => {
    expect(isValidCronExpression(expr)).toBe(true);
  });

  it.each(['', '0 9 * *', '0 9 * * * *', '60 * * * *', '0 24 * * *', '0 9 * * 7', '*/0 * * * *', '0-30/5 * * * *', '0 9 L * *', '5-1 * * * *'])(
    'rejects %s',
    (expr) => {
      expect(isValidCronExpression(expr)).toBe(false);
    },
  );
});

describe('recurringScheduleTriggers', () => {
  it('normalizes recurring schedule triggers and skips everything else', () => {
    expect(
      recurringScheduleTriggers([
        scheduleTrigger,
        { ...scheduleTrigger, id: 'no-tz', timezone: undefined, isEnabled: false, name: 'Nightly' },
        { id: 'once', type: 'schedule', scheduleType: 'one_time', executeAt: '2026-10-01T09:00' },
        { id: 'bad', type: 'schedule', cronExpression: 'whenever' },
        entityTrigger,
      ]),
    ).toEqual([
      { triggerId: 'trigger-2', name: null, cronExpression: '0 9 * * 1-5', timezone: 'Europe/Amsterdam', isEnabled: true },
      { triggerId: 'no-tz', name: 'Nightly', cronExpression: '0 9 * * 1-5', timezone: 'UTC', isEnabled: false },
    ]);
  });
});

describe('isSequenceWorkflow', () => {
  it('detects the CRM sequence tag', () => {
    expect(isSequenceWorkflow(['__type:sequence'])).toBe(true);
    expect(isSequenceWorkflow(['vip'])).toBe(false);
    expect(isSequenceWorkflow(null)).toBe(false);
  });
});
