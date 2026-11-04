import { describe, expect, it } from 'vitest';
import { PROJECT_REQUEST_STATUSES } from '@weldsuite/app-api-client/schemas/flow-portfolio';
import { CAPACITY_MESSAGES } from './capacity';
import {
  DEFAULT_SCORING_MODEL,
  INTAKE_MESSAGES,
  REQUEST_SEQUENCE,
  amountText,
  desiredDatesError,
  isOpenRequestStatus,
  normalizeNeededSkills,
  presentProjectRequest,
  presentSettings,
  requestCode,
  scoreBreakdown,
  scoreRequest,
  scoresError,
  scoringModelError,
  unknownCriterionMessage,
} from './intake';

const model = DEFAULT_SCORING_MODEL;

describe('numbering', () => {
  it('numbers requests once per workspace with the REQ- prefix', () => {
    expect(REQUEST_SEQUENCE).toEqual({ scope: 'req', prefix: 'REQ-' });
    expect(requestCode(14)).toBe('REQ-14');
  });
});

describe('scoring model', () => {
  it('starts with value, fit, urgency, risk and effort adding up to 100', () => {
    expect(model.map((c) => [c.key, c.weight, c.inverse])).toEqual([
      ['value', 35, false],
      ['fit', 25, false],
      ['urgency', 15, false],
      ['risk', 15, true],
      ['effort', 10, true],
    ]);
    expect(scoringModelError(model)).toBeNull();
  });

  it('needs weights that add up to 100 and keys that are unique', () => {
    expect(scoringModelError([{ key: 'a', label: 'A', weight: 60, inverse: false }, { key: 'b', label: 'B', weight: 30, inverse: true }])).toBe(
      INTAKE_MESSAGES.weightsTotal,
    );
    expect(scoringModelError([{ key: 'a', label: 'A', weight: 100, inverse: false }])).toBeNull();
    expect(scoringModelError([{ key: 'a', label: 'A', weight: 50, inverse: false }, { key: 'a', label: 'B', weight: 50, inverse: true }])).toBe(
      INTAKE_MESSAGES.duplicateCriteria,
    );
  });
});

describe('score', () => {
  // The Intake mockup: value 5, fit 5, urgency 4, risk 3, effort 4 on 35/25/15/15/10.
  const supplierPortal = { value: 5, fit: 5, urgency: 4, risk: 3, effort: 4 };

  it('adds weight × rating ÷ 5 and counts risk and effort as 6 − rating', () => {
    // 35 + 25 + 12 + 15 × 3 ÷ 5 (= 9) + 10 × 2 ÷ 5 (= 4) = 85
    expect(scoreRequest(model, supplierPortal)).toBe(85);
    expect(scoreRequest(model, { value: 5, fit: 5, urgency: 5, risk: 1, effort: 1 })).toBe(100);
    expect(scoreRequest(model, { value: 1, fit: 1, urgency: 1, risk: 5, effort: 5 })).toBe(20);
  });

  it('is null until every criterion is rated, and ignores keys the model does not have', () => {
    expect(scoreRequest(model, { value: 5, fit: 5 })).toBeNull();
    expect(scoreRequest(model, {})).toBeNull();
    expect(scoreRequest(model, { ...supplierPortal, extra: 5 })).toBe(85);
    expect(scoreRequest(model, { ...supplierPortal, value: 6 })).toBeNull();
    expect(scoreRequest(model, { ...supplierPortal, value: 2.5 })).toBeNull();
    expect(scoreRequest([], supplierPortal)).toBeNull();
  });

  it('keeps two decimals', () => {
    const odd = [
      { key: 'a', label: 'A', weight: 33, inverse: false },
      { key: 'b', label: 'B', weight: 67, inverse: false },
    ];
    // (33 × 2 + 67 × 4) ÷ 5 = 66.8
    expect(scoreRequest(odd, { a: 2, b: 4 })).toBe(66.8);
    // (33 × 1 + 67 × 2) ÷ 5 = 33.4
    expect(scoreRequest(odd, { a: 1, b: 2 })).toBe(33.4);
  });

  it('shows how the score adds up', () => {
    const lines = scoreBreakdown(model, { ...supplierPortal, effort: undefined as unknown as number });
    expect(lines).toEqual([
      { key: 'value', label: 'Value', weight: 35, inverse: false, value: 5, points: 35 },
      { key: 'fit', label: 'Strategic fit', weight: 25, inverse: false, value: 5, points: 25 },
      { key: 'urgency', label: 'Urgency', weight: 15, inverse: false, value: 4, points: 12 },
      { key: 'risk', label: 'Risk', weight: 15, inverse: true, value: 3, points: 9 },
      { key: 'effort', label: 'Effort', weight: 10, inverse: true, value: null, points: null },
    ]);
  });

  it('names the first unknown criterion, by key', () => {
    expect(scoresError(model, supplierPortal)).toBeNull();
    expect(scoresError(model, { zeta: 1, alpha: 2, value: 3 })).toBe(unknownCriterionMessage('alpha'));
    expect(unknownCriterionMessage('alpha')).toBe('Unknown scoring criterion: alpha');
  });
});

describe('request rules', () => {
  it('lets a new or assessing request be edited and scored', () => {
    expect(PROJECT_REQUEST_STATUSES.filter(isOpenRequestStatus)).toEqual(['new', 'assessing']);
  });

  it('checks the desired dates', () => {
    expect(desiredDatesError(null, null)).toBeNull();
    expect(desiredDatesError('2027-01-11', null)).toBeNull();
    expect(desiredDatesError(undefined, '2027-03-31')).toBeNull();
    expect(desiredDatesError('2027-01-11', '2027-03-31')).toBeNull();
    expect(desiredDatesError('2027-03-31', '2027-01-11')).toBe(CAPACITY_MESSAGES.periodOrder);
    expect(desiredDatesError('2027-02-30', null)).toBe(CAPACITY_MESSAGES.invalidDate);
    expect(desiredDatesError(null, '2027-13-01')).toBe(CAPACITY_MESSAGES.invalidDate);
  });

  it('stores needed skills with their hours only when given, and money with two decimals', () => {
    expect(normalizeNeededSkills([{ skill: 'Backend', hoursPerWeek: 40 }, { skill: 'PM' }])).toEqual([
      { skill: 'Backend', hoursPerWeek: 40 },
      { skill: 'PM' },
    ]);
    expect(amountText(140000)).toBe('140000.00');
    expect(amountText(12.5)).toBe('12.50');
    expect(amountText(null)).toBeNull();
    expect(amountText(undefined)).toBeNull();
  });
});

describe('wire shapes', () => {
  const now = new Date('2026-11-03T10:00:00.000Z');
  it('shows a request with its code, score as a number and timestamps as ISO strings', () => {
    const shown = presentProjectRequest({
      id: 'prq_1',
      number: 14,
      title: 'Supplier portal',
      requestedBy: 'u1',
      businessCase: null,
      estimatedCost: '140000.00',
      estimatedValue: null,
      scores: { value: 5 },
      score: '85.00',
      neededSkills: [{ skill: 'Backend', hoursPerWeek: 40 }],
      desiredStart: '2027-01-11',
      desiredEnd: null,
      status: 'assessing',
      submittedAt: now,
      projectId: null,
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    expect(shown.code).toBe('REQ-14');
    expect(shown.score).toBe(85);
    expect(shown.estimatedCost).toBe('140000.00');
    expect(shown.submittedAt).toBe('2026-11-03T10:00:00.000Z');
    expect('deletedAt' in shown).toBe(false);
  });

  it('shows the defaults for a workspace without settings', () => {
    expect(presentSettings(null)).toEqual({
      id: null,
      scoringModel: [...DEFAULT_SCORING_MODEL],
      portfolioBoardIds: [],
      expenseApprovalLimit: null,
      updatedBy: null,
      updatedAt: null,
    });
  });
});
