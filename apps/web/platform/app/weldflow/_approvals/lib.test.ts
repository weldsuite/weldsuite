import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { interpolate } from '@weldsuite/i18n/provider';
import { answersFor, decideFormSchema, noteRequired, ruleText, slipLabel } from './lib';

describe('decideFormSchema', () => {
  const schema = decideFormSchema('A comment is required');

  it('needs a comment to decline or to set conditions, and a blank one does not count', () => {
    for (const decision of ['rejected', 'approved_with_conditions'] as const) {
      const empty = schema.safeParse({ decision, note: '' });
      expect(empty.success).toBe(false);
      expect(empty.success ? '' : empty.error.issues[0]?.message).toBe('A comment is required');
      expect(schema.safeParse({ decision, note: '   ' }).success).toBe(false);
      expect(schema.safeParse({ decision, note: 'Too expensive' }).success).toBe(true);
    }
  });

  it('lets an approval or a question go without a comment', () => {
    expect(schema.safeParse({ decision: 'approved', note: '' }).success).toBe(true);
    expect(schema.safeParse({ decision: 'info_requested', note: '' }).success).toBe(true);
    expect(noteRequired('approved')).toBe(false);
  });

  it('offers a time entry only approve and decline', () => {
    expect(answersFor({ source: 'timesheet' })).toEqual(['approved', 'rejected']);
    expect(answersFor({ source: 'approval' })).toHaveLength(4);
  });
});

describe('ruleText', () => {
  const money = (value: number) => `EUR ${value}`;
  const text = (rule: Parameters<typeof ruleText>[0]) => ruleText(rule, en.flowApprovals.reviews.rules, interpolate, money);

  it('says why the board was asked, with the figures', () => {
    expect(text({ code: 'change_board_over_limit', params: { costDelta: 8000, scheduleDeltaDays: 2 } })).toBe(
      'You are on the change board, and this change is over a limit (EUR 8000 cost, 2 days).',
    );
  });

  it('tells a manager with no board that the change is over a limit', () => {
    expect(text({ code: 'change_manager', params: { noBoard: true } })).toContain('no change board');
    expect(text({ code: 'change_manager' })).toContain('under the limits');
  });

  it('adds the reason the requester gave to a risk acceptance', () => {
    expect(text({ code: 'risk_acceptance', params: { score: 16, note: 'Cheaper' } })).toBe(
      'You are the sponsor, and this risk scores 16 with the strategy accept. Reason given: Cheaper',
    );
  });

  it('has a fallback for a rule it does not know, and none for a time entry', () => {
    expect(text({ code: 'something_new' })).toBe(en.flowApprovals.reviews.rules.unknown);
    expect(text(null)).toBeNull();
  });
});

describe('slipLabel', () => {
  it('labels a slip, an early finish and no movement', () => {
    expect(slipLabel(8)).toBe('+8d');
    expect(slipLabel(-2)).toBe('-2d');
    expect(slipLabel(0)).toBeNull();
    expect(slipLabel(null)).toBeNull();
  });
});

describe('translations', () => {
  const keys = (value: unknown, prefix = ''): string[] =>
    Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      child !== null && typeof child === 'object' ? keys(child, `${prefix}${key}.`) : [`${prefix}${key}`],
    );

  it('has every key of the flowApprovals module in en and nl', () => {
    expect(keys(nl.flowApprovals).sort()).toEqual(keys(en.flowApprovals).sort());
  });
});
