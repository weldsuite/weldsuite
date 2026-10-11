import { describe, expect, it } from 'vitest';
import { DEFAULT_DUNNING_DAYS, evaluateDunning, type DunningStatement } from './billing';

const DAY = 86_400_000;
const due = new Date('2026-10-01T00:00:00Z');
const at = (daysAfterDue: number, extraMs = 0) => new Date(due.getTime() + daysAfterDue * DAY + extraMs);
const stmt = (id: string, dueAt: Date | null, snapshot?: Record<string, unknown>): DunningStatement => ({
  id,
  dueAt,
  contractSnapshot: snapshot,
});
const evaluate = (statements: DunningStatement[], now: Date, pausedUntil?: Date | null) =>
  evaluateDunning({ statements, fallback: { ...DEFAULT_DUNNING_DAYS }, pausedUntil, now });

describe('evaluateDunning', () => {
  it('is current with nothing unpaid', () => {
    const state = evaluate([], at(40));
    expect(state).toMatchObject({ stage: 'current', status: 'active', statementId: null, daysOverdue: 0 });
  });

  it('walks the stages from the invoice due date: 14 past due, 23 final warning, 30 suspended', () => {
    const s = [stmt('pst_1', due)];
    expect(evaluate(s, at(0)).stage).toBe('current');
    expect(evaluate(s, at(13, DAY - 1)).stage).toBe('current');
    expect(evaluate(s, at(14))).toMatchObject({ stage: 'past_due', status: 'past_due', daysOverdue: 14 });
    expect(evaluate(s, at(22, DAY - 1)).stage).toBe('past_due');
    expect(evaluate(s, at(23))).toMatchObject({ stage: 'final_warning', status: 'past_due' });
    expect(evaluate(s, at(29, DAY - 1)).stage).toBe('final_warning');
    expect(evaluate(s, at(30))).toMatchObject({ stage: 'suspended', status: 'suspended', statementId: 'pst_1' });
    expect(evaluate(s, at(90)).stage).toBe('suspended');
  });

  it('takes the worst stage across several unpaid statements', () => {
    const older = stmt('pst_old', new Date(due.getTime() - 10 * DAY));
    const newer = stmt('pst_new', due);
    // 25 days past the older due date (final warning), 15 past the newer one (past due).
    const state = evaluate([newer, older], at(15));
    expect(state).toMatchObject({ stage: 'final_warning', statementId: 'pst_old', daysOverdue: 25 });
  });

  it('ties on stage go to the statement that is further overdue', () => {
    const a = stmt('pst_a', new Date(due.getTime() - 1 * DAY));
    const b = stmt('pst_b', due);
    const state = evaluate([b, a], at(15));
    expect(state.stage).toBe('past_due');
    expect(state.statementId).toBe('pst_a');
  });

  it('holds the clock while a staff pause is in force and resumes after it', () => {
    const s = [stmt('pst_1', due)];
    const paused = evaluate(s, at(45), new Date(at(46)));
    expect(paused).toMatchObject({ stage: 'current', status: 'active' });
    expect(evaluate(s, at(47), new Date(at(46))).stage).toBe('suspended');
  });

  it('judges a statement by the dunning days it was priced with', () => {
    // 7 / 14 days: suspended at day 14, final warning from day 7 (14 - 7).
    const s = [stmt('pst_1', due, { pastDueAfterDays: 3, readOnlyAfterDays: 14 })];
    expect(evaluate(s, at(3)).stage).toBe('past_due');
    expect(evaluate(s, at(7)).stage).toBe('final_warning');
    expect(evaluate(s, at(14))).toMatchObject({ stage: 'suspended', readOnlyAfterDays: 14, pastDueAfterDays: 3 });
  });

  it('falls back to the contract days when the snapshot is missing or inconsistent', () => {
    const missing = [stmt('pst_1', due, {})];
    expect(evaluate(missing, at(14)).stage).toBe('past_due');
    const inverted = [stmt('pst_2', due, { pastDueAfterDays: 30, readOnlyAfterDays: 10 })];
    expect(evaluate(inverted, at(14))).toMatchObject({ stage: 'past_due', readOnlyAfterDays: 30 });
  });

  it('ignores statements without a due date', () => {
    expect(evaluate([stmt('pst_1', null)], at(60)).stage).toBe('current');
  });
});
