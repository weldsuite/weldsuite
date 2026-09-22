import { describe, expect, it } from 'vitest';

import {
  buildMailAutoLabelQuestions,
  buildMailAutoLabelState,
  matchedLabelsFromJevAnswers,
  MAIL_AUTO_LABEL_PREVIEW_CHARS,
} from './mail-auto-label';

const candidates = [
  {
    id: 'lbl_billing',
    name: 'Billing',
    aiDescription: 'Invoices, payments, refunds',
    aiConfidence: 70,
  },
  {
    id: 'lbl_support',
    name: 'Support',
    aiDescription: 'Product bugs and outages',
    aiConfidence: 80,
  },
];

describe('buildMailAutoLabelQuestions', () => {
  it('emits one noul question keyed by label id', () => {
    const questions = buildMailAutoLabelQuestions(candidates);
    expect(Object.keys(questions)).toEqual(['lbl_billing', 'lbl_support']);
    expect(questions.lbl_billing).toMatchObject({
      type: 'noul',
      instructions: expect.stringContaining('Billing'),
    });
    expect(questions.lbl_billing?.type).toBe('noul');
    if (questions.lbl_billing?.type === 'noul') {
      expect(questions.lbl_billing.criteria?.true).toContain('Billing');
    }
  });
});

describe('buildMailAutoLabelState', () => {
  it('truncates the body preview', () => {
    const state = buildMailAutoLabelState({
      subject: 'Hi',
      from: { name: 'Ada', email: 'ada@example.com' },
      to: [{ email: 'inbox@weldmail.com' }],
      textBody: 'x'.repeat(MAIL_AUTO_LABEL_PREVIEW_CHARS + 50),
    });
    expect(state.preview).toHaveLength(MAIL_AUTO_LABEL_PREVIEW_CHARS);
    expect(state.from.email).toBe('ada@example.com');
  });
});

describe('matchedLabelsFromJevAnswers', () => {
  it('applies labels whose noul meets the per-label threshold', () => {
    const matched = matchedLabelsFromJevAnswers(candidates, {
      lbl_billing: { type: 'noul', noul: 0.71 },
      lbl_support: { type: 'noul', noul: 0.79 }, // below 80%
    });
    expect(matched).toEqual(['Billing']);
  });

  it('defaults missing confidence to 70%', () => {
    const matched = matchedLabelsFromJevAnswers(
      [{ id: 'lbl_x', name: 'X', aiDescription: 'x', aiConfidence: null }],
      { lbl_x: { type: 'noul', noul: 0.7 } },
    );
    expect(matched).toEqual(['X']);
  });

  it('ignores non-noul answers', () => {
    const matched = matchedLabelsFromJevAnswers(candidates, {
      lbl_billing: {
        type: 'choice',
        choice: 'billing',
        confidence: 1,
        probabilities: { billing: 1 },
      },
    });
    expect(matched).toEqual([]);
  });
});
