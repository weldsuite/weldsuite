import { describe, expect, it } from 'vitest';
import type { Form1099FilingLine } from '@/lib/api/domains/weldbooks-1099';
import { buildLinePatch, initialLineEditorValues, isEmptyPatch, type LineEditorValues } from './line-patch';

function line(overrides: Partial<Form1099FilingLine> = {}): Form1099FilingLine {
  return {
    id: 'l1',
    filingId: 'f1',
    partyId: 'p1',
    partyName: 'Acme',
    recipient: { name: 'Acme LLC', tinType: 'ein', tinLast4: '6789' },
    hasTin: true,
    boxes: { nec_1: 2500 },
    adjustments: null,
    federalWithheld: '0.00',
    stateCode: null,
    stateIdNumber: null,
    stateIncome: null,
    stateWithheld: null,
    status: 'included',
    excludedReason: null,
    isCorrected: false,
    correctionOfLineId: null,
    deliveryMethod: null,
    deliveredAt: null,
    superseded: false,
    pendingCorrection: false,
    stateHint: null,
    ...overrides,
  };
}

function edited(base: Form1099FilingLine, change: Partial<LineEditorValues>): LineEditorValues {
  return { ...initialLineEditorValues(base), ...change };
}

describe('buildLinePatch: a line of a draft filing', () => {
  it('sends nothing when nothing changed', () => {
    const base = line();
    const result = buildLinePatch(base, initialLineEditorValues(base), { pendingCorrection: false });
    expect(result).toEqual({ ok: true, patch: {} });
    if (result.ok) expect(isEmptyPatch(result.patch)).toBe(true);
  });

  it('sends the adjustments with box, signed amount and reason', () => {
    const base = line();
    const result = buildLinePatch(
      base,
      edited(base, { adjustments: [{ box: 'nec_1', amount: '-125.50', reason: 'Refund of March invoice' }, { box: 'nec_3', amount: '1,000', reason: 'Missed check' }] }),
      { pendingCorrection: false },
    );
    expect(result).toEqual({
      ok: true,
      patch: {
        adjustments: [
          { box: 'nec_1', amount: -125.5, reason: 'Refund of March invoice' },
          { box: 'nec_3', amount: 1000, reason: 'Missed check' },
        ],
      },
    });
  });

  it('keeps existing adjustments out of the patch until they change, and sends an empty list to remove them all', () => {
    const base = line({ adjustments: [{ box: 'nec_1', amount: 50, reason: 'Late bill', by: 'user_1', at: '2026-10-01T00:00:00.000Z' }] });
    expect(buildLinePatch(base, initialLineEditorValues(base), { pendingCorrection: false })).toEqual({ ok: true, patch: {} });
    expect(buildLinePatch(base, edited(base, { adjustments: [] }), { pendingCorrection: false })).toEqual({
      ok: true,
      patch: { adjustments: [] },
    });
  });

  it('refuses an adjustment without a reason, with a zero amount or a bad amount, naming the row', () => {
    const base = line();
    const result = buildLinePatch(
      base,
      edited(base, {
        adjustments: [
          { box: 'nec_1', amount: '10', reason: '' },
          { box: 'nec_1', amount: '0', reason: 'x' },
          { box: 'nec_1', amount: '1.234', reason: 'x' },
        ],
      }),
      { pendingCorrection: false },
    );
    expect(result).toEqual({
      ok: false,
      problems: [
        { field: 'adjustment', index: 0, problem: 'reason' },
        { field: 'adjustment', index: 1, problem: 'zero' },
        { field: 'adjustment', index: 2, problem: 'amount' },
      ],
    });
  });

  it('excludes a recipient only with a reason, and includes again without one', () => {
    const base = line();
    expect(buildLinePatch(base, edited(base, { excluded: true, excludedReason: '' }), { pendingCorrection: false })).toEqual({
      ok: false,
      problems: [{ field: 'excludedReason' }],
    });
    expect(buildLinePatch(base, edited(base, { excluded: true, excludedReason: ' Paid through payroll ' }), { pendingCorrection: false })).toEqual({
      ok: true,
      patch: { status: 'excluded', excludedReason: 'Paid through payroll' },
    });

    const off = line({ status: 'excluded', excludedReason: 'Paid through payroll' });
    expect(buildLinePatch(off, initialLineEditorValues(off), { pendingCorrection: false })).toEqual({ ok: true, patch: {} });
    expect(buildLinePatch(off, edited(off, { excluded: false }), { pendingCorrection: false })).toEqual({ ok: true, patch: { status: 'included' } });
  });

  it('sends state details as typed: the code upper-cased, amounts as numbers, blanks as null', () => {
    const base = line();
    const result = buildLinePatch(base, edited(base, { stateCode: 'ca', stateIdNumber: ' 123-456 ', stateIncome: '2,500.00', stateWithheld: '0' }), { pendingCorrection: false });
    expect(result).toEqual({
      ok: true,
      patch: { stateCode: 'CA', stateIdNumber: '123-456', stateIncome: 2500, stateWithheld: 0 },
    });

    const withState = line({ stateCode: 'CA', stateIdNumber: '123', stateIncome: '2500.00', stateWithheld: '10.00' });
    expect(buildLinePatch(withState, initialLineEditorValues(withState), { pendingCorrection: false })).toEqual({ ok: true, patch: {} });
    expect(buildLinePatch(withState, edited(withState, { stateCode: '', stateIdNumber: '', stateIncome: '', stateWithheld: '' }), { pendingCorrection: false })).toEqual({
      ok: true,
      patch: { stateCode: null, stateIdNumber: null, stateIncome: null, stateWithheld: null },
    });
  });

  it('refuses state amounts that are not amounts', () => {
    const base = line();
    const result = buildLinePatch(base, edited(base, { stateIncome: 'lots', stateWithheld: '-5' }), { pendingCorrection: false });
    expect(result).toEqual({ ok: false, problems: [{ field: 'stateIncome' }, { field: 'stateWithheld' }] });
  });
});

describe('buildLinePatch: a correction that has not been filed', () => {
  const pending = line({ isCorrected: true, pendingCorrection: true, boxes: { nec_1: 2500 } });

  it('sets the boxes directly, never adjustments', () => {
    const result = buildLinePatch(pending, edited(pending, { boxes: { nec_1: '2,400.00', nec_3: '' }, adjustments: [{ box: 'nec_1', amount: '5', reason: 'x' }] }), { pendingCorrection: true });
    expect(result).toEqual({ ok: true, patch: { boxes: { nec_1: 2400 } } });
  });

  it('sends nothing when the boxes are the same', () => {
    expect(buildLinePatch(pending, initialLineEditorValues(pending), { pendingCorrection: true })).toEqual({ ok: true, patch: {} });
  });

  it('refuses an amount that is not an amount, naming its box', () => {
    expect(buildLinePatch(pending, edited(pending, { boxes: { nec_1: 'lots' } }), { pendingCorrection: true })).toEqual({
      ok: false,
      problems: [{ field: 'box', code: 'nec_1' }],
    });
  });

  it('withdraws the correction only with a reason', () => {
    expect(buildLinePatch(pending, edited(pending, { excluded: true }), { pendingCorrection: true })).toEqual({
      ok: false,
      problems: [{ field: 'excludedReason' }],
    });
    expect(buildLinePatch(pending, edited(pending, { excluded: true, excludedReason: 'Filed by mistake' }), { pendingCorrection: true })).toEqual({
      ok: true,
      patch: { status: 'excluded', excludedReason: 'Filed by mistake' },
    });
  });
});
