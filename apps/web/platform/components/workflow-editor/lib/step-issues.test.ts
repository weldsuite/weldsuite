import { describe, expect, it } from 'vitest';
import { findUnknownVariables, getStepFormatIssues, type VariableScope } from './step-issues';

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
