import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? to.replace('$id', params.id ?? '') : to}>{children}</a>
  ),
}));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string) => value,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));

import { PreFileCheckResult } from './pre-file-check-card';
import { renderWithProviders } from '../../shared/test-support';
import type { PreFileCheck } from '@/lib/api/domains/weldbooks-sales-tax-center';

function makeCheck(overrides: Partial<PreFileCheck> = {}): PreFileCheck {
  return {
    returnId: 'txr_1',
    agencyId: 'sta_wa',
    stateCode: 'WA',
    periodStart: '2026-07-01',
    periodEnd: '2026-09-30',
    comparison: { returnNetSales: 9750, incomeShippedToState: 10250, difference: 500 },
    skipped: [],
    findings: [],
    ok: true,
    ...overrides,
  };
}

const netSalesFinding: PreFileCheck['findings'][number] = {
  code: 'net_sales_difference',
  severity: 'error',
  message: 'Income of invoices shipped to WA (10250.00) differs from the net sales on the return (9750.00).',
  count: 2,
  amount: 500,
  truncated: false,
  documents: [
    {
      documentType: 'invoice',
      documentId: 'inv_1',
      number: 'INV-0042',
      date: '2026-08-12',
      contactName: 'Acme Corp',
      amount: 800,
      returnAmount: 300,
      reason: 'Income differs from the sales the return counts',
    },
    {
      documentType: 'invoice',
      documentId: 'inv_2',
      number: 'INV-0050',
      date: '2026-09-02',
      contactName: null,
      amount: 200,
      returnAmount: 0,
      reason: 'No tax-ledger rows for this agency: its income is not on the return',
    },
  ],
};

const shipToFinding: PreFileCheck['findings'][number] = {
  code: 'missing_ship_to',
  severity: 'warning',
  message: 'Invoices have no ship-to or bill-to state, so their sales cannot be reported to any state.',
  count: 1,
  amount: 120,
  truncated: true,
  documents: [
    {
      documentType: 'credit_note',
      documentId: 'cn_1',
      number: 'CM-0003',
      date: '2026-07-20',
      contactName: 'Bolt Inc',
      amount: -120,
      reason: 'No ship-to state',
    },
  ],
};

describe('PreFileCheckResult', () => {
  it('says the return is OK to file when nothing was found', () => {
    renderWithProviders(<PreFileCheckResult check={makeCheck()} />);

    const ok = screen.getByTestId('pre-file-ok');
    expect(ok).toHaveTextContent('OK to file');
    expect(ok).toHaveTextContent('No differences found.');
    expect(screen.queryByTestId('pre-file-issues')).not.toBeInTheDocument();
  });

  it('shows the net sales against the income shipped to the state', () => {
    renderWithProviders(<PreFileCheckResult check={makeCheck()} />);

    const comparison = screen.getByTestId('pre-file-comparison');
    expect(comparison).toHaveTextContent('Net sales on the return$9750.00');
    expect(comparison).toHaveTextContent('Income shipped to WA$10250.00');
    expect(comparison).toHaveTextContent('Difference$500.00');
  });

  it('counts the findings and lists the documents behind each one', () => {
    renderWithProviders(
      <PreFileCheckResult check={makeCheck({ ok: false, findings: [netSalesFinding, shipToFinding] })} />,
    );

    expect(screen.queryByTestId('pre-file-ok')).not.toBeInTheDocument();
    expect(screen.getByTestId('pre-file-issues')).toHaveTextContent('2 issues to look at');

    const net = screen.getByTestId('finding-net_sales_difference');
    expect(within(net).getByText('Net sales differ from income')).toBeInTheDocument();
    expect(within(net).getByText('Error')).toBeInTheDocument();
    expect(within(net).getByText(/Documents: 2/)).toBeInTheDocument();
    // The sentence is ours, built from the comparison, not the server's English.
    expect(within(net).getByText(/shipped to WA \(\$10250\.00\) differs from the net sales on the return \(\$9750\.00\)/)).toBeInTheDocument();
    // Links go to the document, with the income and what the return counts side by side.
    expect(within(net).getByRole('link', { name: 'INV-0042' })).toHaveAttribute('href', '/weldbooks/invoices/inv_1');
    expect(within(net).getByText('Acme Corp')).toBeInTheDocument();
    expect(within(net).getByText('Income differs from the sales the return counts')).toBeInTheDocument();
    expect(within(net).getByText('No tax-ledger rows for this agency: its income is not on the return')).toBeInTheDocument();
    expect(within(net).getByText('$800.00')).toBeInTheDocument();
    expect(within(net).getByText('$300.00')).toBeInTheDocument();

    const shipTo = screen.getByTestId('finding-missing_ship_to');
    expect(within(shipTo).getByText('Invoices without a ship-to state')).toBeInTheDocument();
    expect(within(shipTo).getByText('Warning')).toBeInTheDocument();
    expect(within(shipTo).getByRole('link', { name: 'CM-0003' })).toHaveAttribute('href', '/weldbooks/invoices/cn_1');
    expect(within(shipTo).getByText('More documents are not listed.')).toBeInTheDocument();
    // No "On the return" column when no document carries that amount.
    expect(within(shipTo).queryByText('On the return')).not.toBeInTheDocument();
  });

  it('uses the singular for one issue', () => {
    renderWithProviders(<PreFileCheckResult check={makeCheck({ ok: false, findings: [shipToFinding] })} />);
    expect(screen.getByTestId('pre-file-issues')).toHaveTextContent('1 issue to look at');
  });

  it('links a journal entry finding to the entry', () => {
    const finding: PreFileCheck['findings'][number] = {
      code: 'payable_direct_entries',
      severity: 'warning',
      message: 'Journal entries moved the agency payable account directly.',
      count: 1,
      amount: 50,
      truncated: false,
      documents: [
        { documentType: 'journal_entry', documentId: 'je_9', number: 'JE-0009', date: '2026-08-01', contactName: null, amount: 50, reason: 'Accrual correction' },
      ],
    };
    renderWithProviders(<PreFileCheckResult check={makeCheck({ ok: false, comparison: null, findings: [finding] })} />);

    expect(screen.getByRole('link', { name: 'JE-0009' })).toHaveAttribute('href', '/weldbooks/journal/je_9');
    // A reason we have no translation for (the entry's own description) is shown as the server sent it.
    expect(screen.getByText('Accrual correction')).toBeInTheDocument();
    expect(screen.queryByTestId('pre-file-comparison')).not.toBeInTheDocument();
  });

  it('explains the checks that did not run, in our words', () => {
    renderWithProviders(
      <PreFileCheckResult
        check={makeCheck({
          comparison: null,
          skipped: [
            'net_sales_difference: a cash-basis return counts sales when paid, so it does not match income of the period',
            'payable_direct_entries: the agency has no payable account of its own',
          ],
        })}
      />,
    );

    const skipped = screen.getByTestId('pre-file-skipped');
    expect(skipped).toHaveTextContent('Net sales comparison: A cash-basis return counts sales when they are paid');
    expect(skipped).toHaveTextContent('Entries on the payable account: The agency has no payable account of its own.');
  });
});
