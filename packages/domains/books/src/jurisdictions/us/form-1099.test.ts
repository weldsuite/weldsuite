import { describe, it, expect } from 'vitest';
import {
  FORM_1099_BOXES,
  FORM_1099_STATE_RULES,
  form1099Box,
  form1099BoxesFor,
  form1099Deadlines,
  form1099StateRule,
  form1099Thresholds,
  form8508Deadline,
  isAllocatableBox,
  meetsThreshold,
  mustEFileInformationReturns,
  stateNeedsDirectFiling,
  withholdingBoxFor,
} from './form-1099';

describe('1099 boxes', () => {
  it('has unique codes and the boxes of both forms', () => {
    const codes = FORM_1099_BOXES.map((def) => def.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(form1099BoxesFor('nec').map((def) => def.number)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(form1099BoxesFor('misc').map((def) => def.number)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17',
    ]);
  });

  it('knows which boxes a payment can land in', () => {
    expect(isAllocatableBox('nec_1')).toBe(true);
    expect(isAllocatableBox('misc_10')).toBe(true);
    expect(isAllocatableBox('nec_4')).toBe(false);
    expect(isAllocatableBox('misc_7')).toBe(false);
    expect(isAllocatableBox('nec_5')).toBe(false);
    expect(isAllocatableBox('nope')).toBe(false);
    expect(withholdingBoxFor('misc')).toBe('misc_4');
    expect(form1099Box('misc_6')?.corporation).toBe('always');
    expect(form1099Box('nec_1')?.corporation).toBe('attorney');
  });
});

describe('1099 thresholds', () => {
  it('uses $600 for payments made in 2025, royalties $10', () => {
    const set = form1099Thresholds(2025);
    expect(set.boxes.nec_1).toBe(600);
    expect(set.boxes.misc_1).toBe(600);
    expect(set.boxes.misc_3).toBe(600);
    expect(set.boxes.misc_6).toBe(600);
    expect(set.boxes.misc_2).toBe(10);
    expect(set.boxes.misc_10).toBe(600);
    expect(set.published).toBe(true);
  });

  it('uses $2,000 for the section 6041 boxes from 2026 and keeps the fixed ones', () => {
    const set = form1099Thresholds(2026);
    for (const code of ['nec_1', 'misc_1', 'misc_3', 'misc_6', 'misc_9', 'misc_12', 'misc_14'] as const) {
      expect(set.boxes[code]).toBe(2000);
    }
    expect(set.boxes.misc_2).toBe(10);
    expect(set.boxes.misc_8).toBe(10);
    expect(set.boxes.misc_10).toBe(600);
    expect(set.boxes.misc_11).toBe(600);
    expect(set.boxes.nec_4).toBeNull();
    expect(set.boxes.nec_2).toBeUndefined();
  });

  it('carries 2026 forward for later years and takes the published amount as an override', () => {
    expect(form1099Thresholds(2027)).toMatchObject({ published: false, boxes: { nec_1: 2000, misc_2: 10 } });
    const indexed = form1099Thresholds(2027, { general: 2100, boxes: { misc_2: 15 } });
    expect(indexed.boxes.nec_1).toBe(2100);
    expect(indexed.boxes.misc_1).toBe(2100);
    expect(indexed.boxes.misc_2).toBe(15);
    expect(indexed.boxes.misc_10).toBe(600);
  });

  it('rejects years before the 1099-NEC existed', () => {
    expect(() => form1099Thresholds(2019)).toThrow(RangeError);
  });

  it('reports exactly the threshold ("or more")', () => {
    expect(meetsThreshold(2000, 2000)).toBe(true);
    expect(meetsThreshold(1999.99, 2000)).toBe(false);
    expect(meetsThreshold(600, 600)).toBe(true);
    expect(meetsThreshold(0.1 + 0.2 + 599.7, 600)).toBe(true);
    expect(meetsThreshold(0.01, null)).toBe(true);
    expect(meetsThreshold(0, null)).toBe(false);
  });
});

describe('1099 due dates', () => {
  it('rolls tax year 2026 to 1 February 2027 because 31 January is a Sunday', () => {
    const deadlines = form1099Deadlines(2026);
    expect(deadlines.nec).toEqual({ recipient: '2027-02-01', irs: '2027-02-01' });
    expect(deadlines.misc.recipient).toBe('2027-02-01');
    expect(deadlines.form945).toBe('2027-02-01');
    expect(deadlines.misc.irsPaper).toBe('2027-03-01'); // 28 February 2027 is a Sunday
    expect(deadlines.misc.irsElectronic).toBe('2027-03-31');
    expect(deadlines.misc.recipientBoxes8And10).toBe('2027-02-16'); // Washington's Birthday
  });

  it('keeps 31 January when it is a business day', () => {
    expect(form1099Deadlines(2025).nec.irs).toBe('2026-02-02'); // 31 January 2026 is a Saturday
    expect(form1099Deadlines(2024).nec.irs).toBe('2025-01-31');
  });

  it('applies the 10-return e-file rule and the Form 8508 lead time', () => {
    expect(mustEFileInformationReturns(9)).toBe(false);
    expect(mustEFileInformationReturns(10)).toBe(true);
    expect(form8508Deadline('2027-02-01')).toBe('2026-12-18');
  });
});

describe('1099 state filing', () => {
  it('has a rule for every state and DC', () => {
    expect(FORM_1099_STATE_RULES).toHaveLength(51);
    expect(new Set(FORM_1099_STATE_RULES.map((rule) => rule.state)).size).toBe(51);
  });

  it('carries the CF/SF codes of Pub 1220 and none for Missouri', () => {
    expect(form1099StateRule('CA')?.cfsfCode).toBe('06');
    expect(form1099StateRule('WI')?.cfsfCode).toBe('55');
    expect(form1099StateRule('MO')?.cfsfCode).toBeNull();
    expect(FORM_1099_STATE_RULES.filter((rule) => rule.cfsfCode).length).toBe(32);
  });

  it('never claims a direct-filing rule is verified', () => {
    expect(FORM_1099_STATE_RULES.every((rule) => rule.verified === false)).toBe(true);
  });

  it('asks for direct filing only when the trigger applies', () => {
    expect(stateNeedsDirectFiling('PA', { stateWithheld: true })).toBe(true);
    expect(stateNeedsDirectFiling('PA', { stateSource: true })).toBe(false);
    expect(stateNeedsDirectFiling('MA', { stateSource: true })).toBe(true);
    expect(stateNeedsDirectFiling('TX', { stateWithheld: true })).toBe(false);
    expect(stateNeedsDirectFiling('XX', { stateWithheld: true })).toBe(false);
  });
});
