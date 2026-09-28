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
