import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value,
  }),
}));

import { WorksheetCard } from './worksheet-card';
import { makeReturn, makeSummary, renderWithProviders } from '../../shared/test-support';

describe('WorksheetCard totals', () => {
  it('walks from gross sales to the total tax due', () => {
    renderWithProviders(<WorksheetCard ret={makeReturn()} />);

    expect(screen.getByTestId('ws-gross-sales')).toHaveTextContent('Gross sales$12500.00');
    expect(screen.getByTestId('ws-total-deductions')).toHaveTextContent('$2750.00');
    expect(screen.getByTestId('ws-taxable-sales')).toHaveTextContent('Taxable sales$9750.00');
    expect(screen.getByTestId('ws-sales-tax-due')).toHaveTextContent('$804.38');
    expect(screen.getByTestId('ws-use-tax-due')).toHaveTextContent('$20.00');
    expect(screen.getByTestId('ws-total-tax-due')).toHaveTextContent('Total tax due$824.38');
  });

  it('lists only the deductions that are not zero, by reason', () => {
    renderWithProviders(<WorksheetCard ret={makeReturn()} />);

    expect(screen.getByTestId('ws-deduction-resale')).toHaveTextContent('Sales for resale$2000.00');
    expect(screen.getByTestId('ws-deduction-non_taxable')).toHaveTextContent('Non-taxable sales$500.00');
    expect(screen.getByTestId('ws-deduction-returns')).toHaveTextContent('Returns and allowances$250.00');
    expect(screen.queryByTestId('ws-deduction-government')).not.toBeInTheDocument();
    expect(screen.queryByText('No deductions')).not.toBeInTheDocument();
  });

  it('says so when there are no deductions', () => {
    const summary = makeSummary({
      deductions: { ...makeSummary().deductions, resale: 0, non_taxable: 0, returns: 0 },
      totalDeductions: 0,
    });
    renderWithProviders(<WorksheetCard ret={makeReturn({ summary })} />);
    expect(screen.getByText('No deductions')).toBeInTheDocument();
  });

  it('breaks the tax out by location, with a use tax table of its own', () => {
    renderWithProviders(<WorksheetCard ret={makeReturn()} />);

    const sales = screen.getByRole('heading', { name: 'Tax by location' }).parentElement as HTMLElement;
    expect(within(sales).getByText('Seattle')).toBeInTheDocument();
    expect(within(sales).getByText('1700')).toBeInTheDocument();
    expect(within(sales).getByText('3.55%')).toBeInTheDocument();
    // The total of the two sales rows: 633.75 + 170.63.
    expect(within(sales).getByText('$804.38')).toBeInTheDocument();

    const use = screen.getByRole('heading', { name: 'Use tax by location' }).parentElement as HTMLElement;
    expect(within(use).getByText('Washington')).toBeInTheDocument();
    expect(within(use).getByText('$20.00')).toBeInTheDocument();
  });

  it('shows no use tax table when there is no use tax', () => {
    const lines = makeReturn().lines!.filter((line) => line.kind === 'sales');
    renderWithProviders(<WorksheetCard ret={makeReturn({ lines })} />);
    expect(screen.queryByRole('heading', { name: 'Use tax by location' })).not.toBeInTheDocument();
  });

  it('renders nothing before the first calculation', () => {
    const { container } = renderWithProviders(<WorksheetCard ret={makeReturn({ status: 'open', summary: null, lines: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('WorksheetCard notices', () => {
  it('warns about exempt sales that are counted as taxable for lack of a certificate', () => {
    const summary = makeSummary({ uncuredExempt: { sales: 1200, tax: 98.4, lines: 3 } });
    renderWithProviders(<WorksheetCard ret={makeReturn({ summary })} />);

    const notice = screen.getByTestId('uncured-notice');
    expect(notice).toHaveTextContent('3 exempt sale lines ($1200.00)');
    expect(notice).toHaveTextContent('Tax on them: $98.40');
    expect(within(notice).getByRole('link', { name: 'See missing certificates' })).toHaveAttribute(
      'href',
      '/weldbooks/sales-tax/certificates/reports',
    );
  });

  it('does not warn when every exempt sale has a certificate', () => {
    renderWithProviders(<WorksheetCard ret={makeReturn()} />);
    expect(screen.queryByTestId('uncured-notice')).not.toBeInTheDocument();
  });

  it('tells an amended return pays only the difference to the return it amends', () => {
    const summary = makeSummary({ previouslyReported: { returnId: 'txr_0', salesTaxDue: 700, useTaxDue: 20, uncuredTax: 0 } });
    renderWithProviders(<WorksheetCard ret={makeReturn({ summary, amendsReturnId: 'txr_0' })} />);
    expect(screen.getByTestId('previously-reported-notice')).toHaveTextContent('sales tax $700.00 and use tax $20.00');
  });

  it('says how many rows were carried forward from earlier periods', () => {
    const summary = makeSummary({ carriedForward: { returnIds: ['txr_0'], rowCount: 2, taxAmount: 12.5 } });
    renderWithProviders(<WorksheetCard ret={makeReturn({ summary })} />);
    expect(screen.getByTestId('carried-forward-notice')).toHaveTextContent('Includes 2 rows carried forward');
  });
});
