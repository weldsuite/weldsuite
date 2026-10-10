import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  getConfigSummary,
  summarizeStep,
  summarizeTrigger,
  type NodeSummaryLabels,
  type TriggerSummaryContext,
} from './node-summary';

const labels: NodeSummaryLabels = {
  configured: 'Configured',
  to: 'To: {to}',
  delay: 'Wait {duration}',
  duration: {
    day: { one: '{count} day', other: '{count} days' },
    hour: { one: '{count} hour', other: '{count} hours' },
    minute: { one: '{count} minute', other: '{count} minutes' },
    second: { one: '{count} second', other: '{count} seconds' },
  },
  entity: 'Entity: {entityType}',
  trigger: {
    manual: 'Manually triggered',
    webhook: 'HTTP endpoint',
    api: 'Triggered via API',
    integrationEvent: 'Connected app event',
    recurringSchedule: 'Recurring schedule',
    scheduled: 'Scheduled',
    afterSucceeds: 'After "{name}" succeeds',
    afterFails: 'After "{name}" fails',
    afterFinishes: 'After "{name}" finishes',
  },
};

const ctx: TriggerSummaryContext = {
  labels,
  entityEvents: [
    {
      entityType: 'project_task',
      label: 'Task',
      events: [
        { id: 'created', name: 'Task Created' },
        { id: 'stage_changed', name: 'Task Stage Changed' },
      ],
    },
    { entityType: 'ticket', label: 'Ticket', events: ['created', 'closed'] },
  ],
  cronPresets: [{ cron: '0 9 * * *', label: 'Every day at 9:00' }],
  workflows: [{ id: 'wf_1', name: 'Onboarding' }],
  integrationTriggers: [{ id: 'github.issue_opened', name: 'GitHub issue opened' }],
  locale: 'en',
};

describe('summarizeTrigger', () => {
  it('names the entity and event of an entity_event trigger', () => {
    expect(summarizeTrigger({ type: 'entity_event', entityType: 'project_task', eventType: 'created' }, ctx)).toBe('Task created');
    expect(summarizeTrigger({ type: 'entity_event', entityType: 'project_task', eventType: 'stage_changed' }, ctx)).toBe(
      'Task stage changed',
    );
  });

  it('reads the entity event from a nested config too', () => {
    expect(
      summarizeTrigger({ type: 'entity_event', config: { entityType: 'project_task', eventType: 'created' } }, ctx),
    ).toBe('Task created');
  });

  it('falls back to the entity label for events that are plain strings or unknown', () => {
    expect(summarizeTrigger({ type: 'entity_event', entityType: 'ticket', eventType: 'closed' }, ctx)).toBe('Ticket closed');
    expect(summarizeTrigger({ type: 'entity_event', entityType: 'mystery_thing', eventType: 'went_boom' }, ctx)).toBe(
      'Mystery thing went boom',
    );
  });

  it('has no summary until both the entity and the event are chosen', () => {
    expect(summarizeTrigger({ type: 'entity_event' }, ctx)).toBeUndefined();
    expect(summarizeTrigger({ type: 'entity_event', entityType: 'project_task', eventType: '' }, ctx)).toBeUndefined();
  });

  it('shows the preset label of a recurring schedule, else its cron expression', () => {
    expect(summarizeTrigger({ type: 'schedule', scheduleType: 'recurring', cronExpression: '0 9 * * *' }, ctx)).toBe(
      'Every day at 9:00',
    );
    expect(summarizeTrigger({ type: 'schedule', scheduleType: 'recurring', cronExpression: '*/7 * * * *' }, ctx)).toBe(
      '*/7 * * * *',
    );
  });

  it('shows the fire time of a one-time schedule', () => {
    const summary = summarizeTrigger({ type: 'schedule', scheduleType: 'one_time', executeAt: '2030-01-15T09:00' }, ctx);
    expect(summary).toContain('2030');
    expect(summary).toContain('Jan');
  });

  it('has no summary for a schedule that is not filled in', () => {
    expect(summarizeTrigger({ type: 'schedule' }, ctx)).toBeUndefined();
    expect(summarizeTrigger({ type: 'schedule', scheduleType: 'one_time', executeAt: '' }, ctx)).toBeUndefined();
    expect(summarizeTrigger({ type: 'schedule', scheduleType: 'recurring' }, ctx)).toBe('Recurring schedule');
  });

  it('summarises the fixed trigger types', () => {
    expect(summarizeTrigger({ type: 'manual' }, ctx)).toBe('Manually triggered');
    expect(summarizeTrigger({ type: 'webhook' }, ctx)).toBe('HTTP endpoint');
    expect(summarizeTrigger({ type: 'api' }, ctx)).toBe('Triggered via API');
  });

  it('names the workflow a workflow_complete trigger waits for', () => {
    expect(summarizeTrigger({ type: 'workflow_complete', sourceWorkflowId: 'wf_1', triggerOn: 'success' }, ctx)).toBe(
      'After "Onboarding" succeeds',
    );
    expect(summarizeTrigger({ type: 'workflow_complete', sourceWorkflowId: 'wf_1', triggerOn: 'failure' }, ctx)).toBe(
      'After "Onboarding" fails',
    );
    expect(summarizeTrigger({ type: 'workflow_complete', config: { sourceWorkflowId: 'wf_1', triggerOn: 'both' } }, ctx)).toBe(
      'After "Onboarding" finishes',
    );
    expect(summarizeTrigger({ type: 'workflow_complete', sourceWorkflowId: 'gone' }, ctx)).toBeUndefined();
  });

  it('names the event of an integration trigger', () => {
    expect(summarizeTrigger({ type: 'integration_event', provider: 'github', event: 'github.issue_opened' }, ctx)).toBe(
      'GitHub issue opened',
    );
    expect(summarizeTrigger({ type: 'integration_event', provider: 'slack', event: 'message' }, ctx)).toBe('slack: message');
    expect(summarizeTrigger({ type: 'integration_event' }, ctx)).toBe('Connected app event');
  });

  it('leaves unknown trigger types and missing triggers to the canvas', () => {
    expect(summarizeTrigger({ type: 'conversation_created' }, ctx)).toBeUndefined();
    expect(summarizeTrigger(undefined, ctx)).toBeUndefined();
  });
});

describe('summarizeStep', () => {
  it('summarises send_email with recipient and subject', () => {
    expect(summarizeStep({ type: 'send_email', config: { to: 'a@example.com', subject: 'Hi', body: 'x' } }, labels)).toBe(
      'To: a@example.com • Hi',
    );
    expect(summarizeStep({ type: 'send_email', config: { to: 'a@example.com' } }, labels)).toBe('To: a@example.com');
  });

  it('summarises send_notification by its title', () => {
    expect(summarizeStep({ type: 'send_notification', config: { title: 'New signup', userIds: ['u1'] } }, labels)).toBe(
      'New signup',
    );
  });

  it('summarises http_request with the stored method, defaulting to GET', () => {
    expect(summarizeStep({ type: 'http_request', config: { method: 'POST', url: 'https://x.test/hook' } }, labels)).toBe(
      'POST https://x.test/hook',
    );
    expect(summarizeStep({ type: 'http_request', config: { url: 'https://x.test/hook' } }, labels)).toBe('GET https://x.test/hook');
  });

  it('says "Configured" for a complete step without a more specific summary', () => {
    expect(summarizeStep({ type: 'send_notification', config: { userIds: ['u1'], title: '  ' } }, labels)).toBeUndefined();
    expect(summarizeStep({ type: 'manual_step', config: { title: 'Approve', approvers: ['u1'] } }, labels)).toBe('Approve');
    expect(summarizeStep({ type: 'update_contact', config: { contactId: 'c1', phone: '1' } }, labels)).toBe('Configured');
  });

  it('has no summary for a step that is empty or still missing required fields', () => {
    expect(summarizeStep({ type: 'send_notification', config: {} }, labels)).toBeUndefined();
    expect(summarizeStep({ type: 'send_email', config: { subject: 'No recipient yet' } }, labels)).toBeUndefined();
    expect(summarizeStep({ type: 'http_request', config: { method: 'GET' } }, labels)).toBeUndefined();
    expect(summarizeStep({ type: 'send_email' }, labels)).toBeUndefined();
  });

  it('shows a delay as a humanised duration, not the raw number (the QA "Wait 3600 seconds")', () => {
    expect(summarizeStep({ type: 'delay', config: { seconds: 3600 } }, labels)).toBe('Wait 1 hour');
    expect(summarizeStep({ type: 'delay', config: { seconds: '3600' } }, labels)).toBe('Wait 1 hour');
    expect(summarizeStep({ type: 'delay', config: { minutes: 90 } }, labels)).toBe('Wait 1 hour 30 minutes');
    expect(summarizeStep({ type: 'delay', config: { hours: 48 } }, labels)).toBe('Wait 2 days');
    expect(summarizeStep({ type: 'delay', config: { days: 1 } }, labels)).toBe('Wait 1 day');
    expect(summarizeStep({ type: 'delay', config: { seconds: 45 } }, labels)).toBe('Wait 45 seconds');
  });

  it('reads the delay field the way the engine does: the first set unit wins', () => {
    expect(summarizeStep({ type: 'delay', config: { days: 2, hours: 5, seconds: 9 } }, labels)).toBe('Wait 2 days');
    expect(summarizeStep({ type: 'delay', config: { days: 0, minutes: 5 } }, labels)).toBe('Wait 5 minutes');
  });

  it('has no delay summary until a positive duration is set', () => {
    expect(getConfigSummary('delay', {}, labels)).toBe('');
    expect(getConfigSummary('delay', { seconds: 0 }, labels)).toBe('');
    expect(getConfigSummary('delay', { seconds: '{{variables.wait}}' }, labels)).toBe('');
  });

  it('truncates long messages', () => {
    const summary = getConfigSummary('post_chat_message', { message: 'x'.repeat(100) }, labels);
    expect(summary).toBe(`${'x'.repeat(60)}...`);
  });
});

describe('formatDuration', () => {
  it('picks the largest unit and pluralises it', () => {
    expect(formatDuration(1, labels.duration)).toBe('1 second');
    expect(formatDuration(60, labels.duration)).toBe('1 minute');
    expect(formatDuration(120, labels.duration)).toBe('2 minutes');
    expect(formatDuration(3600, labels.duration)).toBe('1 hour');
    expect(formatDuration(7200, labels.duration)).toBe('2 hours');
    expect(formatDuration(86_400, labels.duration)).toBe('1 day');
    expect(formatDuration(259_200, labels.duration)).toBe('3 days');
  });

  it('keeps the two largest units of an uneven span', () => {
    expect(formatDuration(90, labels.duration)).toBe('1 minute 30 seconds');
    expect(formatDuration(5400, labels.duration)).toBe('1 hour 30 minutes');
    expect(formatDuration(129_600, labels.duration)).toBe('1 day 12 hours');
    // the third unit is dropped
    expect(formatDuration(86_400 + 3600 + 60, labels.duration)).toBe('1 day 1 hour');
  });

  it('is empty for a span that is not positive', () => {
    expect(formatDuration(0, labels.duration)).toBe('');
    expect(formatDuration(-5, labels.duration)).toBe('');
    expect(formatDuration(Number.NaN, labels.duration)).toBe('');
  });
});
