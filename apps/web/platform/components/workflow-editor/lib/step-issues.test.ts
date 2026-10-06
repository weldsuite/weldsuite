import { describe, expect, it } from 'vitest';
import {
  findUnknownVariables,
  getStepFormatIssues,
  isInsideLoop,
  isNestedWaitingStep,
  type VariableScope,
} from './step-issues';

describe('getStepFormatIssues', () => {
  it('flags a literal recipient that is not an email address', () => {
    expect(getStepFormatIssues({ type: 'send_email', config: { to: 'not-an-email', subject: 's', body: 'b' } })).toEqual([
      { labelKey: 'to', kind: 'email', value: 'not-an-email' },
    ]);
  });

  it('checks every address of to, cc and bcc', () => {
    const issues = getStepFormatIssues({
      type: 'send_email',
      config: { to: 'a@example.com, nope', cc: 'Jane <jane@example.com>; also bad', bcc: ['x@example.com', 'y'] },
    });
    expect(issues.map((issue) => `${issue.labelKey}:${issue.value}`)).toEqual(['to:nope', 'cc:also bad', 'bcc:y']);
  });

  it('leaves values with a variable to the engine, which knows what they resolve to', () => {
    expect(
      getStepFormatIssues({ type: 'send_email', config: { to: '{{trigger.record.email}}', cc: '{{variables.team}}, a@example.com' } }),
    ).toEqual([]);
  });

  it('accepts empty optional fields', () => {
    expect(getStepFormatIssues({ type: 'send_email', config: { to: 'a@example.com', cc: '', bcc: '  ' } })).toEqual([]);
  });

  it('checks the email and website of a create_customer step', () => {
    expect(
      getStepFormatIssues({ type: 'create_customer', config: { name: 'Acme', email: 'info@', website: 'not a url' } }),
    ).toEqual([
      { labelKey: 'customerEmail', kind: 'email', value: 'info@' },
      { labelKey: 'customerWebsite', kind: 'url', value: 'not a url' },
    ]);
    expect(
      getStepFormatIssues({ type: 'create_customer', config: { name: 'Acme', email: 'info@acme.com', website: 'acme.com' } }),
    ).toEqual([]);
    expect(
      getStepFormatIssues({ type: 'create_customer', config: { name: 'Acme', website: 'https://acme.com/about' } }),
    ).toEqual([]);
  });

  it('checks the email of a create_lead step', () => {
    expect(getStepFormatIssues({ type: 'create_lead', config: { email: 'info@' } })).toEqual([
      { labelKey: 'leadEmail', kind: 'email', value: 'info@' },
    ]);
    expect(getStepFormatIssues({ type: 'create_lead', config: { email: 'info@acme.com' } })).toEqual([]);
  });

  it('has nothing to say about other step types', () => {
    expect(getStepFormatIssues({ type: 'delay', config: { to: 'not-an-email' } })).toEqual([]);
    expect(getStepFormatIssues({})).toEqual([]);
  });
});

describe('findUnknownVariables', () => {
  const leadScope: VariableScope = {
    triggerType: 'entity_event',
    recordFields: ['id', 'firstName', 'email', 'address.city'],
    previousStepIds: ['step-1'],
    variableNames: ['team'],
  };

  it('accepts the variables that exist for the workflow', () => {
    const config = {
      to: '{{trigger.record.email}}',
      subject: 'New {{trigger.entity}} {{ trigger.record.firstName }} in {{trigger.record.address.city}}',
      body: '{{steps.step-1.customerId}} {{variables.team}} {{trigger.recordId}} {{trigger.workflowName}}',
    };
    expect(findUnknownVariables(config, leadScope)).toEqual([]);
  });

  it('reports a field the record does not have, a later step, and a root the engine cannot resolve', () => {
    const config = {
      subject: '{{trigger.record.doesNotExist}} {{trigger.record.company}}',
      body: 'Hello {{contact.firstName}}, {{steps.step-9.result}} {{env.NODE_ENV}} {{variables.missing}}',
    };
    expect(findUnknownVariables(config, leadScope)).toEqual([
      'trigger.record.doesNotExist',
      'trigger.record.company',
      'contact.firstName',
      'steps.step-9.result',
      'env.NODE_ENV',
      'variables.missing',
    ]);
  });

  it('does not check record fields of an entity without a field list', () => {
    const scope: VariableScope = { ...leadScope, recordFields: undefined };
    expect(findUnknownVariables({ body: '{{trigger.record.anything}}' }, scope)).toEqual([]);
  });

  it('knows which trigger keys each trigger type has', () => {
    const schedule: VariableScope = { triggerType: 'schedule', previousStepIds: [], variableNames: [] };
    expect(
      findUnknownVariables({ body: '{{trigger.scheduledTime}} {{trigger.scheduledTimeLocal}} {{trigger.record.email}}' }, schedule),
    ).toEqual(['trigger.record.email']);
    // Caller-defined payloads (webhook, api, ...) cannot be checked.
    const webhook: VariableScope = { triggerType: 'webhook', previousStepIds: [], variableNames: [] };
    expect(findUnknownVariables({ body: '{{trigger.body.anything}}' }, webhook)).toEqual([]);
  });

  it('honours roots the host adds and looks inside nested config', () => {
    const scope: VariableScope = { ...leadScope, extraRoots: ['contact'] };
    expect(findUnknownVariables({ fields: [{ value: '{{contact.firstName}}' }, { value: '{{nope.x}}' }] }, scope)).toEqual([
      'nope.x',
    ]);
  });
});

describe('loop variables', () => {
  const scope: VariableScope = { triggerType: 'schedule', previousStepIds: [], variableNames: [] };

  it('knows {{loop.item}} and {{loop.index}} inside a loop body only', () => {
    const config = { text: '{{loop.item.sku}} #{{loop.index}}' };
    expect(findUnknownVariables(config, { ...scope, inLoop: true })).toEqual([]);
    expect(findUnknownVariables(config, scope)).toEqual(['loop.item.sku', 'loop.index']);
    expect(findUnknownVariables({ text: '{{loop.other}}' }, { ...scope, inLoop: true })).toEqual(['loop.other']);
  });

  it('finds a loop body through nested branches', () => {
    const steps = [
      { id: 'l1' },
      { id: 'c1', parentBranchId: 'l1_each' },
      { id: 'deep', parentBranchId: 'c1_if' },
      { id: 'plain', parentBranchId: 'c2_if_not' },
      { id: 'c2' },
    ];
    expect(isInsideLoop(steps[2], steps)).toBe(true);
    expect(isInsideLoop(steps[1], steps)).toBe(true);
    expect(isInsideLoop(steps[3], steps)).toBe(false);
    expect(isInsideLoop(steps[0], steps)).toBe(false);
  });
});

describe('after another workflow (workflow_complete)', () => {
  const scope = (extra: Partial<VariableScope> = {}): VariableScope => ({
    triggerType: 'workflow_complete',
    previousStepIds: [],
    variableNames: [],
    ...extra,
  });
  const config = { body: '{{trigger.sourceWorkflowName}} {{trigger.status}} {{trigger.output.step-1.contactId}}' };

  it('knows the previous run, and its output only when the trigger passes it along', () => {
    expect(findUnknownVariables(config, scope())).toEqual(['trigger.output.step-1.contactId']);
    expect(findUnknownVariables(config, scope({ extraTriggerKeys: ['output'] }))).toEqual([]);
  });
});

describe('isNestedWaitingStep', () => {
  it('flags an approval inside a branch or loop, not one in the main flow or another step type', () => {
    expect(isNestedWaitingStep({ type: 'manual_step', parentBranchId: 'c_if' })).toBe(true);
    expect(isNestedWaitingStep({ type: 'manual_step' })).toBe(false);
    expect(isNestedWaitingStep({ type: 'send_email', parentBranchId: 'l_each' })).toBe(false);
  });
});
