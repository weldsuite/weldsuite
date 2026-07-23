import { describe, it, expect } from 'vitest';
import { evaluateCondition } from './evaluate-condition';

const NONE = {};
const cond = (field: string, operator: string, value?: unknown) => ({ field, operator, value });

describe('evaluateCondition', () => {
  it('fails closed when field is missing', () => {
    expect(evaluateCondition({ operator: 'eq', value: 1 }, NONE, NONE, NONE, NONE)).toBe(false);
  });

  it('fails closed when operator is missing', () => {
    expect(evaluateCondition({ field: 'trigger.x' }, NONE, NONE, { }, NONE)).toBe(false);
  });

  it('returns false for an unknown operator', () => {
    expect(evaluateCondition(cond('trigger.x', 'wat', 1), NONE, { x: 1 }, NONE, NONE)).toBe(false);
  });

  describe('field sources', () => {
    it('reads from trigger', () => {
      expect(evaluateCondition(cond('trigger.status', 'eq', 'open'), NONE, { status: 'open' }, NONE, NONE)).toBe(true);
    });
    it('reads from steps', () => {
      expect(evaluateCondition(cond('steps.a.ok', 'eq', true), { a: { ok: true } }, NONE, NONE, NONE)).toBe(true);
    });
    it('reads from variables', () => {
      expect(evaluateCondition(cond('variables.n', 'gt', 5), NONE, NONE, { n: 6 }, NONE)).toBe(true);
    });
    it('reads from contact', () => {
      expect(evaluateCondition(cond('contact.vip', 'eq', true), NONE, NONE, NONE, { vip: true })).toBe(true);
    });
  });

  describe('operators', () => {
    it('eq / equals', () => {
      expect(evaluateCondition(cond('trigger.x', 'eq', 'a'), NONE, { x: 'a' }, NONE, NONE)).toBe(true);
      expect(evaluateCondition(cond('trigger.x', 'equals', 'a'), NONE, { x: 'b' }, NONE, NONE)).toBe(false);
    });
    it('neq / not_equals', () => {
      expect(evaluateCondition(cond('trigger.x', 'neq', 'a'), NONE, { x: 'b' }, NONE, NONE)).toBe(true);
    });
    it('gt / gte / lt / lte with numeric coercion', () => {
      expect(evaluateCondition(cond('trigger.x', 'gt', 5), NONE, { x: '6' }, NONE, NONE)).toBe(true);
      expect(evaluateCondition(cond('trigger.x', 'gte', 5), NONE, { x: 5 }, NONE, NONE)).toBe(true);
      expect(evaluateCondition(cond('trigger.x', 'lt', 5), NONE, { x: 4 }, NONE, NONE)).toBe(true);
      expect(evaluateCondition(cond('trigger.x', 'lte', 5), NONE, { x: 5 }, NONE, NONE)).toBe(true);
    });
    it('contains / starts_with / ends_with', () => {
      expect(evaluateCondition(cond('trigger.x', 'contains', 'ell'), NONE, { x: 'hello' }, NONE, NONE)).toBe(true);
      expect(evaluateCondition(cond('trigger.x', 'starts_with', 'he'), NONE, { x: 'hello' }, NONE, NONE)).toBe(true);
      expect(evaluateCondition(cond('trigger.x', 'ends_with', 'lo'), NONE, { x: 'hello' }, NONE, NONE)).toBe(true);
    });
    it('exists / not_exists', () => {
      expect(evaluateCondition(cond('trigger.x', 'exists'), NONE, { x: 0 }, NONE, NONE)).toBe(true);
      expect(evaluateCondition(cond('trigger.x', 'exists'), NONE, {}, NONE, NONE)).toBe(false);
      expect(evaluateCondition(cond('trigger.x', 'not_exists'), NONE, {}, NONE, NONE)).toBe(true);
    });
    it('in / not_in require an array value', () => {
      expect(evaluateCondition(cond('trigger.x', 'in', [1, 2, 3]), NONE, { x: 2 }, NONE, NONE)).toBe(true);
      expect(evaluateCondition(cond('trigger.x', 'in', [1, 2, 3]), NONE, { x: 9 }, NONE, NONE)).toBe(false);
      expect(evaluateCondition(cond('trigger.x', 'not_in', [1, 2, 3]), NONE, { x: 9 }, NONE, NONE)).toBe(true);
      // non-array value: `in` is false, `not_in` is true
      expect(evaluateCondition(cond('trigger.x', 'in', 'nope'), NONE, { x: 'nope' }, NONE, NONE)).toBe(false);
    });
    it('matches treats value as a regex', () => {
      expect(evaluateCondition(cond('trigger.x', 'matches', '^a.*z$'), NONE, { x: 'abcz' }, NONE, NONE)).toBe(true);
      expect(evaluateCondition(cond('trigger.x', 'matches', '^\\d+$'), NONE, { x: 'abc' }, NONE, NONE)).toBe(false);
    });
  });
});
