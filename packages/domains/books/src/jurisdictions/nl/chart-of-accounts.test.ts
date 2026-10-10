import { describe, expect, it } from 'vitest';
import { nlChartOfAccounts as chart } from './chart-of-accounts';

describe('NL chart of accounts', () => {
  it('has unique codes, names and system roles', () => {
    const codes = chart.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const roles = chart.map((a) => a.systemRole).filter(Boolean);
    expect(new Set(roles).size).toBe(roles.length);
    for (const account of chart) {
      expect(account.code).toMatch(/^\d{4}$/);
      expect(account.name.length).toBeLessThan(255);
    }
  });

  it('carries the payroll roles the WeldHR journal looks up, on the RGS payroll accounts', () => {
    const byRole = (role: string) => chart.find((a) => a.systemRole === role);
    expect(byRole('payroll_wages_expense')).toMatchObject({ code: '4110', name: 'Lonen en salarissen', type: 'expense', normalSide: 'debit' });
    expect(byRole('payroll_tax_expense')).toMatchObject({ code: '4120', name: 'Sociale lasten', type: 'expense', normalSide: 'debit' });
    expect(byRole('payroll_liabilities')).toMatchObject({ code: '1800', name: 'Loonheffing te betalen', type: 'liability', normalSide: 'credit' });
  });

  it('keeps the codes the journal falls back on for entities created before the roles existed', () => {
    // Pension costs (employer benefits) and the bank account have no role: books-api resolves them by code.
    expect(chart.find((a) => a.code === '4130')).toMatchObject({ name: 'Pensioenlasten', type: 'expense' });
    expect(chart.find((a) => a.code === '1100')).toMatchObject({ name: 'Bank', subtype: 'bank' });
  });
});
