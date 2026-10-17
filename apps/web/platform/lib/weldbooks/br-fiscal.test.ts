import { describe, expect, it } from 'vitest';
import {
  EMPTY_BR_DOCUMENT,
  EMPTY_BR_LINE,
  brDocumentPayload,
  brDocumentProblems,
  brDocumentValuesFromStored,
  brLinePayload,
  brLineProblems,
  brLineValuesFromStored,
  groupBrTaxRows,
  isBrBreakdown,
} from './br-fiscal';

const lineMessages = { ncm: 'ncm', cfop: 'cfop', cest: 'cest', percent: 'percent', issRate: 'issRate' };
const docMessages = { iss: 'iss', irrf: 'irrf', inss: 'inss', accessKey: 'accessKey' };

describe('line fiscal fields', () => {
  it('sends nothing for an untouched line, with nulls that clear a stored one', () => {
    expect(brLinePayload(EMPTY_BR_LINE)).toEqual({ ncm: null, cfop: null, fiscalData: null });
  });

  it('sends NCM, CFOP and only the filled fiscal data, rates as numbers', () => {
    expect(
      brLinePayload({ ...EMPTY_BR_LINE, ncm: '84713012', cfop: '5102', brOrigin: '1', brIcmsRate: '12,5', brServiceCode: ' 01.07 ' }),
    ).toEqual({ ncm: '84713012', cfop: '5102', fiscalData: { origin: '1', icmsRate: 12.5, serviceCode: '01.07' } });
  });

  it('reads a stored line back', () => {
    expect(brLineValuesFromStored({ ncm: '84713012', cfop: '5102', fiscalData: { origin: '2', issRate: 3, cest: '2100100' } })).toMatchObject({
      ncm: '84713012',
      cfop: '5102',
      brOrigin: '2',
      brIssRate: '3',
      brCest: '2100100',
    });
  });

  it('flags a malformed NCM, CFOP, CEST and rates', () => {
    expect(brLineProblems({ ncm: '1234', cfop: '9999', brCest: '12', brIcmsRate: '150', brIssRate: '7' }, lineMessages)).toEqual({
      ncm: 'ncm',
      cfop: 'cfop',
      brCest: 'cest',
      brIcmsRate: 'percent',
      brIssRate: 'issRate',
    });
    expect(brLineProblems({ ncm: '84713012', cfop: '5102', brIcmsRate: '12' }, lineMessages)).toEqual({});
  });
});

describe('document fiscal fields', () => {
  it('sends nothing without withholdings or buyer flags', () => {
    expect(brDocumentPayload(EMPTY_BR_DOCUMENT)).toBeNull();
  });

  it('sends the withholdings and the buyer status as the server schema wants them', () => {
    expect(
      brDocumentPayload({ ...EMPTY_BR_DOCUMENT, brIssWithheld: '2', brIrrf: '1.5', brCsrf: true, brInss: '11', brFinalConsumer: true, brBuyerIcms: 'no' }),
    ).toEqual({
      withholdings: { iss: 2, irrf: 1.5, csrf: true, inss: 11 },
      finalConsumer: true,
      buyerIcmsContributor: false,
    });
  });

  it('sends the supplier access key of a bill only', () => {
    const key = '3'.repeat(44);
    expect(brDocumentPayload({ ...EMPTY_BR_DOCUMENT, brAccessKey: key })).toBeNull();
    expect(brDocumentPayload({ ...EMPTY_BR_DOCUMENT, brAccessKey: key }, { bill: true })).toEqual({ accessKey: key });
  });

  it('round-trips a stored document', () => {
    const stored = { withholdings: { irrf: 1.5, csrf: true }, buyerIcmsContributor: true };
    expect(brDocumentValuesFromStored(stored)).toMatchObject({ brIrrf: '1.5', brCsrf: true, brBuyerIcms: 'yes', brIssWithheld: '' });
    expect(brDocumentValuesFromStored(null)).toEqual(EMPTY_BR_DOCUMENT);
  });

  it('flags withholdings out of range and a short access key', () => {
    expect(brDocumentProblems({ brIssWithheld: '9', brIrrf: '30', brInss: '25', brAccessKey: '123' }, docMessages)).toEqual({
      brIssWithheld: 'iss',
      brIrrf: 'irrf',
      brInss: 'inss',
      brAccessKey: 'accessKey',
    });
  });
});

describe('tax breakdown groups', () => {
  const row = (
    component: string,
    treatment: 'added' | 'embedded' | 'withheld' | 'informational',
    rate: number,
    base: number,
    tax: number,
  ) => ({
    taxRateName: `${component.toUpperCase()} ${rate}%`,
    taxRate: rate,
    taxableAmount: base,
    taxAmount: tax,
    component,
    treatment,
  });

  it('groups by treatment in a fixed order and sums the same tax of several lines', () => {
    const groups = groupBrTaxRows([
      row('irrf', 'withheld', 1.5, 1000, 15),
      row('iss', 'embedded', 2, 1000, 20),
      row('iss', 'embedded', 2, 500, 10),
      row('ipi', 'added', 5, 100, 5),
      row('cbs', 'informational', 0.9, 1000, 9),
    ]);
    expect(groups.map((g) => g.treatment)).toEqual(['added', 'embedded', 'withheld', 'informational']);
    const embedded = groups.find((g) => g.treatment === 'embedded');
    expect(embedded?.rows).toHaveLength(1);
    expect(embedded?.rows[0]).toMatchObject({ taxableAmount: 1500, taxAmount: 30 });
    expect(embedded?.total).toBe(30);
  });

  it('leaves out empty groups and recognises a Brazilian breakdown', () => {
    expect(groupBrTaxRows([])).toEqual([]);
    expect(isBrBreakdown([row('iss', 'embedded', 2, 100, 2)])).toBe(true);
    expect(isBrBreakdown([{ taxRateName: 'VAT 21%', taxRate: 21, taxableAmount: 100, taxAmount: 21 }])).toBe(false);
    expect(isBrBreakdown(null)).toBe(false);
  });
});
