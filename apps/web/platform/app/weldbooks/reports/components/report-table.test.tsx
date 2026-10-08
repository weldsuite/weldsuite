import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReportColumn } from '@/lib/weldbooks/report-types';
import type { ReportRowModel } from './report-model';
import { ReportTable } from './report-table';

const current: ReportColumn = { key: 'current', label: '2026', from: '2026-01-01', to: '2026-12-31' };
const prior: ReportColumn = { key: 'prior', label: '2025', from: '2025-01-01', to: '2025-12-31' };

const labels = { account: 'Account', change: 'Change', changePercent: 'Change %' };
const formatMoney = (value: string | number | null | undefined) => {
  const n = Number(value ?? 0);
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
};
const heading = (column: ReportColumn) => (column.key === 'current' ? 'FY 2026' : column.key === 'prior' ? 'FY 2025' : column.key);

const rows: ReportRowModel[] = [
  { key: 's-income', kind: 'section', label: 'Income', depth: 0, values: {} },
  {
    key: 'a-sales',
    kind: 'account',
    label: 'Sales',
    code: '4000',
    depth: 1,
    values: { current: '1000.00', prior: '800.00' },
    delta: { amount: '200.00', percent: 25 },
    accountId: 'acc_sales',
  },
  {
    key: 'a-interest',
    kind: 'account',
    label: 'Interest',
    depth: 1,
    values: { current: '10.00', prior: '0.00' },
    delta: { amount: '10.00', percent: null },
  },
  {
    key: 't-income',
    kind: 'subtotal',
    label: 'Total income',
    depth: 0,
    values: { current: '1010.00', prior: '800.00' },
    delta: { amount: '210.00', percent: 26.3 },
  },
  {
    key: 't-net',
    kind: 'total',
    label: 'Net income',
    depth: 0,
    values: { current: '510.00', prior: '800.00' },
    delta: { amount: '-290.00', percent: -36.3 },
  },
];

describe('ReportTable', () => {
  it('shows a column per period and the change columns of a comparison', () => {
    render(
      <ReportTable
        caption="Profit and loss"
        columns={[current, prior]}
        rows={rows}
        comparing
        heading={heading}
        formatMoney={formatMoney}
        labels={labels}
      />,
    );

    const table = screen.getByRole('table', { name: 'Profit and loss' });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Account', 'FY 2026', 'FY 2025', 'Change', 'Change %']);

    const sales = within(table).getByRole('row', { name: /Sales/ });
    const cells = within(sales).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['4000Sales', '$1000.00', '$800.00', '+$200.00', '+25%']);
  });

  it('shows no percentage when the comparison amount is zero and signs a decrease', () => {
    render(
      <ReportTable
        caption="Profit and loss"
        columns={[current, prior]}
        rows={rows}
        comparing
        heading={heading}
        formatMoney={formatMoney}
        labels={labels}
      />,
    );
    const interest = screen.getByRole('row', { name: /Interest/ });
    expect(within(interest).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Interest', '$10.00', '$0.00', '+$10.00', '—']);

    const net = screen.getByRole('row', { name: /Net income/ });
    expect(within(net).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Net income', '$510.00', '$800.00', '-$290.00', '-36.3%']);
  });

  it('has no change columns for a single period', () => {
    render(
      <ReportTable
        caption="Profit and loss"
        columns={[current]}
        rows={rows.map((r) => ({ ...r, delta: undefined, values: { current: r.values.current ?? '' } }))}
        comparing={false}
        heading={heading}
        formatMoney={formatMoney}
        labels={labels}
      />,
    );
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Account', 'FY 2026']);
  });

  it('renders section headings as a full-width row and lets a page replace the label of an account', () => {
    render(
      <ReportTable
        caption="Profit and loss"
        columns={[current]}
        rows={rows}
        comparing={false}
        heading={heading}
        formatMoney={formatMoney}
        labels={labels}
        renderLabel={(row) => <a href={`/ledger/${row.accountId ?? ''}`}>{row.label}</a>}
      />,
    );
    expect(screen.getByText('Income', { selector: 'td' })).toHaveAttribute('colspan', '2');
    expect(screen.getByRole('link', { name: 'Sales' })).toHaveAttribute('href', '/ledger/acc_sales');
  });

  it('puts one column per period of a month split next to the total', () => {
    const months: ReportColumn[] = [
      { key: '2026-01', label: '', from: '2026-01-01', to: '2026-01-31' },
      { key: '2026-02', label: '', from: '2026-02-01', to: '2026-02-28' },
      { key: 'total', label: '', from: '2026-01-01', to: '2026-02-28' },
    ];
    render(
      <ReportTable
        caption="Profit and loss"
        columns={months}
        rows={[
          {
            key: 'a',
            kind: 'account',
            label: 'Sales',
            depth: 1,
            values: { '2026-01': '600.00', '2026-02': '400.00', total: '1000.00' },
          },
        ]}
        comparing={false}
        heading={heading}
        formatMoney={formatMoney}
        labels={labels}
      />,
    );
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Account', '2026-01', '2026-02', 'total']);
    expect(within(screen.getByRole('row', { name: /Sales/ })).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'Sales',
      '$600.00',
      '$400.00',
      '$1000.00',
    ]);
  });
});
