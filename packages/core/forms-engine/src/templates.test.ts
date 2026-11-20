import { describe, expect, it } from 'vitest';
import { computePath } from './path';
import { evaluateSubmission } from './submission';
import { STARTER_TEMPLATES } from './templates';
import { parseDefinition } from './validate';

function parsed(id: string) {
  const template = STARTER_TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`no template ${id}`);
  const result = parseDefinition(template.definition);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

describe('STARTER_TEMPLATES', () => {
  it('has eight templates with unique ids and both languages', () => {
    expect(STARTER_TEMPLATES).toHaveLength(8);
    expect(new Set(STARTER_TEMPLATES.map((t) => t.id)).size).toBe(8);
    for (const t of STARTER_TEMPLATES) {
      expect(t.name.en && t.name.nl && t.description.en && t.description.nl).toBeTruthy();
    }
  });

  for (const template of STARTER_TEMPLATES) {
    it(`${template.id} passes parseDefinition`, () => {
      const result = parseDefinition(template.definition);
      expect(result.ok ? [] : result.issues).toEqual([]);
    });
  }

  it('customer feedback asks detractors what went wrong', () => {
    const def = parsed('customer-feedback');
    expect(computePath(def, { answers: { b_nps: 4 } }).path).toEqual(['b_nps', 'b_wrong', 'b_follow_up', 'b_email']);
    expect(computePath(def, { answers: { b_nps: 9, b_follow_up: false } }).path).toEqual(['b_nps', 'b_liked', 'b_follow_up']);
  });

  it('the knowledge quiz picks its ending by score', () => {
    const def = parsed('knowledge-quiz');
    const all = evaluateSubmission(def, {
      answers: { b_q1: { choiceIds: ['c_q1_mercury'] }, b_q2: { choiceIds: ['c_q2_eight'] }, b_q3: { choiceIds: ['c_q3_mars'] } },
    });
    expect(all).toMatchObject({ ok: true, score: 3, endingId: 'e_perfect' });
    const one = evaluateSubmission(def, {
      answers: { b_q1: { choiceIds: ['c_q1_mercury'] }, b_q2: { choiceIds: ['c_q2_seven'] }, b_q3: { choiceIds: ['c_q3_jupiter'] } },
    });
    expect(one).toMatchObject({ ok: true, score: 1, endingId: 'e_good' });
    const none = evaluateSubmission(def, {
      answers: { b_q1: { choiceIds: ['c_q1_venus'] }, b_q2: { choiceIds: ['c_q2_seven'] }, b_q3: { choiceIds: ['c_q3_jupiter'] } },
    });
    expect(none).toMatchObject({ ok: true, score: 0, endingId: 'e_try_again' });
    expect(none.quiz.map((q) => q.correct)).toEqual([false, false, false]);
  });

  it('lead qualification routes small budgets to self-service and big scores to a demo', () => {
    const def = parsed('lead-qualification');
    const small = computePath(def, { answers: { b_size: { choiceIds: ['c_size_1'] }, b_budget: { choiceIds: ['c_budget_1'] } } });
    expect(small).toMatchObject({ path: ['b_size', 'b_budget'], endingId: 'e_self_service' });
    const big = computePath(def, {
      answers: { b_size: { choiceIds: ['c_size_4'] }, b_budget: { choiceIds: ['c_budget_3'] }, b_timeline: { choiceIds: ['c_time_now'] } },
    });
    expect(big).toMatchObject({ endingId: 'e_demo', variables: { score: 8 } });
  });
});
