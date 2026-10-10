import { describe, expect, it } from 'vitest';
import type { NlFilingData } from '../types';
import { nlAnnualStatement, nlAnnualTotals } from './annual-statement';
import { scenario } from './fixtures/employer-scenario';

describe('jaaropgaaf', () => {
  const s = scenario();
  const payslips = s.anna.map((p, i) => ({ payDate: `2026-0${i + 1}-24`, filingData: p.filingData as NlFilingData, ytd: p.ytd }));

  it('adds up the year from the payslips and matches the year-to-date accumulators', () => {
    const t = nlAnnualTotals(payslips);
    const last = s.anna[3]!.ytd;
    expect(t.loonLbPh).toBe(last['nl.loon_lb']);
    expect(t.wageTax).toBe(last['nl.wage_tax']);
    expect(t.labourCredit).toBe(last['nl.labour_credit']);
    expect(t.zvwEmployerLevy).toBe(last['nl.zvw_employer_levy']);
    expect(t.employeeInsurancePremiums).toBe(last['nl.awf_premium']! + last['nl.aof_premium']! + last['nl.wko_premium']! + last['nl.whk_premium']!);
  });

  it('shows the six numbered amounts of the model jaaropgaaf, in Dutch and English', () => {
    const doc = nlAnnualStatement({
      lang: 'nl',
      year: 2026,
      employer: { name: 'Voorbeeld B.V.', loonheffingennummer: '001234560L01', address: ['Herengracht 1', '1015 BA Amsterdam'] },
      employee: { name: 'A.M. de Vries', bsn: '111222333', dateOfBirth: '1988-09-12', address: ['Keizersgracht 123 B'], employmentStart: '2023-02-01', employmentEnd: null, personnelNumber: 'E001' },
      payslips,
    });
    expect(doc.title).toBe('Jaaropgaaf 2026');
    const amounts = doc.sections[2]!;
    expect(amounts.kind).toBe('fields');
    const labels = amounts.kind === 'fields' ? amounts.fields.map((f) => f.label.slice(0, 2)) : [];
    expect(labels).toEqual(['1 ', '2 ', '3 ', '4 ', '5 ', '6 ']);
    const box1 = amounts.kind === 'fields' ? amounts.fields[0]!.value : '';
    expect(box1).toBe('€ 15.200,00');
    const en = nlAnnualStatement({ lang: 'en', year: 2026, employer: { name: 'X', loonheffingennummer: null, address: [] }, employee: { name: 'Y', bsn: null, dateOfBirth: null, address: [], employmentStart: null, employmentEnd: null, personnelNumber: null }, payslips });
    expect(en.title).toBe('Annual statement 2026');
  });
});
