import { describe, it, expect } from 'vitest';
import {
  isSequenceWorkflow,
  isValidCronExpression,
  recurringScheduleTriggers,
  validateWeldConnectWorkflow,
  webhookTriggerIds,
  webhookTriggers,
  workflowCompleteSourceIds,
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
const webhookTrigger = { id: 'trigger-3', type: 'webhook' };
const httpStep = { id: 'step-3', type: 'http_request', config: { url: 'https://api.example.com/hook', method: 'POST' } };

describe('validateWeldConnectWorkflow', () => {
  it('accepts the MVP triggers and actions when fully configured', () => {
    expect(validateWeldConnectWorkflow({ triggers: [entityTrigger], steps: [emailStep, customerStep] })).toEqual([]);
    expect(validateWeldConnectWorkflow({ triggers: [scheduleTrigger], steps: [emailStep] })).toEqual([]);
    expect(validateWeldConnectWorkflow({ triggers: [webhookTrigger], steps: [httpStep] })).toEqual([]);
  });

  it('requires a url for http_request but lets the method default', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [webhookTrigger],
        steps: [{ id: 's', type: 'http_request', config: {} }],
      }),
    ).toEqual([{ code: 'missing_field', stepId: 's', type: 'http_request', field: 'url' }]);
  });

  it('accepts configured ai_generate / ai_classify steps', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [webhookTrigger],
        steps: [
          { id: 'g', type: 'ai_generate', config: { prompt: 'Summarize {{trigger.record.notes}}' } },
          { id: 'c', type: 'ai_classify', config: { text: '{{trigger.record.message}}', categories: ['billing', 'support'] } },
        ],
      }),
    ).toEqual([]);
  });

  it('accepts ai_classify with the input/labels aliases', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [webhookTrigger],
        steps: [{ id: 'c', type: 'ai_classify', config: { input: 'hello', labels: ['a', 'b'] } }],
      }),
    ).toEqual([]);
  });

  it('flags ai_generate / ai_classify missing required fields', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [webhookTrigger],
        steps: [
          { id: 'g', type: 'ai_generate', config: {} },
          { id: 'c', type: 'ai_classify', config: {} },
        ],
      }),
    ).toEqual([
      { code: 'missing_field', stepId: 'g', type: 'ai_generate', field: 'prompt' },
      { code: 'missing_field', stepId: 'c', type: 'ai_classify', field: 'text' },
      { code: 'missing_field', stepId: 'c', type: 'ai_classify', field: 'categories' },
    ]);
  });

  it('still rejects ai_agent (removed in the platform-wide AI teardown, never re-enabled)', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [webhookTrigger],
        steps: [{ id: 's', type: 'ai_agent', config: {} }],
      }),
    ).toEqual([{ code: 'unsupported_action', stepId: 's', type: 'ai_agent' }]);
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
      triggers: [{ id: 't', type: 'manual' }],
      steps: [{ id: 's', type: 'ai_agent', config: {} }],
    });
    expect(issues).toEqual([
      { code: 'unsupported_trigger', triggerId: 't', type: 'manual' },
      { code: 'unsupported_action', stepId: 's', type: 'ai_agent' },
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

  it('accepts configured contact, notification and chat-message steps', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [
          { id: 'a', type: 'create_contact', config: { email: '{{trigger.data.email}}' } },
          { id: 'b', type: 'update_contact', config: { contactId: '{{steps.a.contactId}}', title: 'CTO' } },
          { id: 'c', type: 'send_notification', config: { title: 'New contact' } },
          { id: 'd', type: 'post_chat_message', config: { channelId: 'chan_1', message: 'New contact: {{steps.a.name}}' } },
        ],
      }),
    ).toEqual([]);
  });

  it('accepts post_chat_message with `content` as an alias for `message`', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [{ id: 'd', type: 'post_chat_message', config: { channelId: 'chan_1', content: 'Hi' } }],
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
          { id: 'd', type: 'post_chat_message', config: {} },
        ],
      }),
    ).toEqual([
      { code: 'missing_field', stepId: 'a', type: 'create_contact', field: 'name' },
      { code: 'missing_field', stepId: 'b', type: 'update_contact', field: 'contactId' },
      { code: 'missing_field', stepId: 'c', type: 'send_notification', field: 'title' },
      { code: 'missing_field', stepId: 'd', type: 'post_chat_message', field: 'channelId' },
      { code: 'missing_field', stepId: 'd', type: 'post_chat_message', field: 'message' },
    ]);
  });

  it('accepts configured create_lead / create_deal / move_deal_stage / log_activity steps', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [
          { id: 'a', type: 'create_lead', config: { email: '{{trigger.data.email}}' } },
          { id: 'b', type: 'create_deal', config: { name: 'Renewal', customerId: '{{trigger.record.id}}' } },
          { id: 'c', type: 'move_deal_stage', config: { dealId: '{{steps.b.dealId}}', stageId: 'stg_won' } },
          { id: 'd', type: 'log_activity', config: { type: 'call', subject: 'Discovery call' } },
        ],
      }),
    ).toEqual([]);
  });

  it('reports missing fields for create_lead / create_deal / move_deal_stage / log_activity', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [
          { id: 'a', type: 'create_lead', config: {} },
          { id: 'b', type: 'create_deal', config: { name: 'Renewal' } },
          { id: 'c', type: 'move_deal_stage', config: { dealId: 'deal_1' } },
          { id: 'd', type: 'log_activity', config: {} },
        ],
      }),
    ).toEqual([
      { code: 'missing_field', stepId: 'a', type: 'create_lead', field: 'email' },
      { code: 'missing_field', stepId: 'b', type: 'create_deal', field: 'customerId' },
      { code: 'missing_field', stepId: 'c', type: 'move_deal_stage', field: 'stageId' },
      { code: 'missing_field', stepId: 'd', type: 'log_activity', field: 'subject' },
    ]);
  });

  it('accepts a configured create_task step', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [{ id: 'a', type: 'create_task', config: { projectId: 'proj_1', title: '{{trigger.data.name}}' } }],
      }),
    ).toEqual([]);
  });

  it('reports a create_task step missing its project or title', () => {
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [{ id: 'a', type: 'create_task', config: { title: 'Follow up' } }],
      }),
    ).toEqual([{ code: 'missing_field', stepId: 'a', type: 'create_task', field: 'projectId' }]);
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [{ id: 'a', type: 'create_task', config: { projectId: 'proj_1' } }],
      }),
    ).toEqual([{ code: 'missing_field', stepId: 'a', type: 'create_task', field: 'title' }]);
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

describe('webhookTriggers', () => {
  it('normalizes webhook triggers (enabled or not) and skips everything else', () => {
    expect(
      webhookTriggers([
        webhookTrigger,
        { ...webhookTrigger, id: 'trigger-4', isEnabled: false, name: 'Disabled' },
        { id: 'trigger-5', type: 'webhook', name: 'Named' },
        scheduleTrigger,
        { id: 'too-long-'.repeat(5), type: 'webhook' },
      ]),
    ).toEqual([
      { triggerId: 'trigger-3', name: null, isEnabled: true },
      { triggerId: 'trigger-4', name: 'Disabled', isEnabled: false },
      { triggerId: 'trigger-5', name: 'Named', isEnabled: true },
    ]);
  });
});

describe('webhookTriggerIds', () => {
  it('returns ids of every webhook trigger, enabled or not', () => {
    expect(
      webhookTriggerIds([webhookTrigger, { ...webhookTrigger, id: 'trigger-4', isEnabled: false }, scheduleTrigger]),
    ).toEqual(['trigger-3', 'trigger-4']);
  });
});

describe('validateWeldConnectWorkflow: after another workflow, approvals', () => {
  const email = { id: 's', type: 'send_email', config: { to: 'a@b.co', subject: 's', body: 'b' } };
  const chained = (extra: Record<string, unknown>) => ({ id: 't', type: 'workflow_complete', ...extra });

  it('accepts a workflow_complete trigger flat (editor) or nested under config', () => {
    expect(validateWeldConnectWorkflow({ triggers: [chained({ sourceWorkflowId: 'wf_a', triggerOn: 'failure' })], steps: [email] })).toEqual([]);
    expect(validateWeldConnectWorkflow({ triggers: [chained({ config: { sourceWorkflowId: 'wf_a' } })], steps: [email] })).toEqual([]);
  });

  it('needs a source workflow that is not itself, and a known outcome', () => {
    const codes = (trigger: Record<string, unknown>) =>
      validateWeldConnectWorkflow({ triggers: [trigger], steps: [email] }, { workflowId: 'wf_self' }).map((i) => i.code);
    expect(codes(chained({}))).toEqual(['missing_source_workflow']);
    expect(codes(chained({ sourceWorkflowId: 'wf_self' }))).toEqual(['self_chained_workflow']);
    expect(codes(chained({ sourceWorkflowId: 'wf_a', triggerOn: 'sometimes' }))).toEqual(['invalid_trigger_on']);
  });

  it('accepts an approval in the main flow and flags one inside a branch or loop', () => {
    const trigger = { id: 't', type: 'webhook' };
    expect(
      validateWeldConnectWorkflow({ triggers: [trigger], steps: [{ id: 'a', type: 'manual_step', config: { title: 'Approve' } }] }),
    ).toEqual([]);
    expect(
      validateWeldConnectWorkflow({
        triggers: [trigger],
        steps: [
          { id: 'l', type: 'loop', config: { items: '{{trigger.body.items}}' } },
          { id: 'a', type: 'manual_step', parentBranchId: 'l_each', config: {} },
        ],
      }),
    ).toEqual([
      { code: 'missing_field', stepId: 'a', type: 'manual_step', field: 'title' },
      { code: 'nested_waiting_step', stepId: 'a', type: 'manual_step' },
    ]);
  });
});

describe('workflowCompleteSourceIds', () => {
  it('lists the sources of the enabled workflow_complete triggers', () => {
    expect(
      workflowCompleteSourceIds([
        { id: 't1', type: 'workflow_complete', sourceWorkflowId: 'wf_a' },
        { id: 't2', type: 'workflow_complete', config: { sourceWorkflowId: 'wf_b' } },
        { id: 't3', type: 'workflow_complete', sourceWorkflowId: 'wf_c', isEnabled: false },
        { id: 't4', type: 'workflow_complete', sourceWorkflowId: '' },
        { id: 't5', type: 'schedule' },
      ]),
    ).toEqual([
      { triggerId: 't1', sourceWorkflowId: 'wf_a' },
      { triggerId: 't2', sourceWorkflowId: 'wf_b' },
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
