import { describe, expect, it } from 'vitest';
import type { ReachCampaignStep } from '@weldsuite/app-api-client/schemas/reach';
import {
  customFieldNames,
  insertAtSelection,
  newStep,
  normalizeSteps,
  stepsToDraft,
  templateVariables,
  unknownVariables,
  variableToken,
} from './sequence';

function step(order: number, overrides: Partial<ReachCampaignStep> = {}): ReachCampaignStep {
  return {
    id: `step-${order}`,
    order,
    delayDays: 0,
    delayHours: 0,
    subject: `Subject ${order}`,
    body: `Body ${order}`,
    replyInThread: false,
    ...overrides,
  };
}

describe('stepsToDraft', () => {
  it('sorts by order and drops the ids', () => {
    const draft = stepsToDraft([step(2, { delayDays: 4 }), step(1)]);
    expect(draft.map((s) => s.subject)).toEqual(['Subject 1', 'Subject 2']);
    expect(draft[1]?.delayDays).toBe(4);
    expect(draft[0]).not.toHaveProperty('id');
  });

  it('starts an empty campaign with one blank first email', () => {
    const draft = stepsToDraft([]);
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({ delayDays: 0, subject: '', body: '', replyInThread: false });
  });
});

describe('normalizeSteps', () => {
  it('zeroes the first step delay and leaves the others', () => {
    const steps = normalizeSteps([
      { ...newStep(), delayDays: 5, delayHours: 2 },
      { ...newStep(), delayDays: 3 },
    ]);
    expect(steps[0]).toMatchObject({ delayDays: 0, delayHours: 0 });
    expect(steps[1]?.delayDays).toBe(3);
  });
});

describe('templateVariables', () => {
  it('finds names, with fallbacks and spacing, once each', () => {
    expect(
      templateVariables('Hi {{firstName|there}}, {{ companyName }} and {{firstName}} again'),
    ).toEqual(['firstName', 'companyName']);
  });

  it('ignores text that only looks like a placeholder', () => {
    expect(templateVariables('{firstName} {{ }} {{a b}}')).toEqual([]);
  });
});

describe('unknownVariables', () => {
  it('accepts built-in and custom field variables', () => {
    expect(
      unknownVariables(['{{firstName}} {{industry}} {{nope}}', '{{senderFullName}}'], ['industry']),
    ).toEqual(['nope']);
  });
});

describe('insertAtSelection', () => {
  it('replaces the selection and moves the cursor after the insertion', () => {
    expect(insertAtSelection('Hello world', 6, 11, variableToken('firstName'))).toEqual({
      value: 'Hello {{firstName}}',
      cursor: 19,
    });
  });

  it('clamps a selection outside the text', () => {
    expect(insertAtSelection('abc', 10, 12, 'X')).toEqual({ value: 'abcX', cursor: 4 });
  });
});

describe('customFieldNames', () => {
  it('collects sorted unique names', () => {
    expect(
      customFieldNames([
        { customFields: { industry: 'x', city: 'y' } },
        { customFields: { city: 'z' } },
      ]),
    ).toEqual(['city', 'industry']);
  });
});
