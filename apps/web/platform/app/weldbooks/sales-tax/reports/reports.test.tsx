import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? to.replace('$id', params.id ?? '') : to}>{children}</a>
  ),
}));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string | null) => value ?? '—',
  formatDateTime: (value: string | null) => value ?? '—',
  formatMonth: (value: string) => value.slice(0, 7),
  today: () => '2026-10-08',
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
vi.mock('../shared/sales-tax-frame', () => ({
  SalesTaxFrame: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

import SalesTaxReportsPage from './page';
import { filterExceptions } from './exceptions-report';
import { installPointerPolyfills, renderWithProviders } from '../shared/test-support';
import type {
  LiabilityReport,
  ProviderReconciliation,
  SalesSummary,
  SalesTaxException,
  SalesTaxExceptionsReport,
} from '@/lib/api/domains/weldbooks-sales-tax-center';

const liability: LiabilityReport = {
  asOf: '2026-10-08',
  agencies: [
    {
      agencyId: 'sta_wa',
      agencyName: 'Washington Department of Revenue',
      stateCode: 'WA',
      status: 'registered',
      collected: 1500,
      filed: 1000,
      paid: 700,
      outstanding: 800,
      unfiled: 500,
      filedUnpaid: 300,
      glBalance: 800,
      difference: 0,
      jurisdictions: [
        { jurisdictionCode: 'WA', jurisdictionName: 'Washington', level: 'state', collected: 1000, filed: 700, paid: 500, outstanding: 500 },
        { jurisdictionCode: 'WA-SEA', jurisdictionName: 'Seattle', level: 'city', collected: 500, filed: 300, paid: 200, outstanding: 300 },
      ],
      warnings: [],
    },
    {
      agencyId: 'sta_tx',
      agencyName: 'Texas Comptroller',
      stateCode: 'TX',
      status: 'registered',
      collected: 400,
      filed: 400,
      paid: 400,
      outstanding: 0,
      unfiled: 0,
      filedUnpaid: 0,
      glBalance: 25.5,
      difference: 25.5,
      jurisdictions: [],
      warnings: [],
    },
  ],
  totals: { collected: 1900, filed: 1400, paid: 1100, outstanding: 800, glBalance: 825.5, difference: 25.5 },
};

const zero = { grossSales: 0, taxableSales: 0, exemptSales: 0, exemptByReason: {}, nonTaxableSales: 0, marketplaceSales: 0, tax: 0, documents: 0 };

const summary: SalesSummary = {
  from: '2026-01-01',
  to: '2026-10-08',
  groupBy: 'state',
  rows: [
    { key: 'WA', label: 'WA', ...zero, grossSales: 9000, taxableSales: 8000, exemptSales: 700, exemptByReason: { resale: 500, government: 200 }, nonTaxableSales: 300, tax: 800, documents: 12 },
    { key: 'OR', label: 'OR', ...zero, grossSales: 1000, taxableSales: 0, nonTaxableSales: 1000, documents: 2 },
  ],
  totals: { ...zero, grossSales: 10000, taxableSales: 8000, exemptSales: 700, nonTaxableSales: 1300, tax: 800, documents: 14 },
};

function exception(overrides: Partial<SalesTaxException> = {}): SalesTaxException {
  return {
    kind: 'no_ship_to_state',
    severity: 'error',
    documentType: 'invoice',
    documentId: 'inv_1',
    documentNumber: 'INV-1',
    date: '2026-09-01',
    contactName: 'Acme Corp',
    stateCode: null,
    amount: 100,
    taxAmount: 0,
    message: 'The document has no ship-to or bill-to state, so the tax cannot be sourced.',
    ...overrides,
  };
}

const exceptionsReport: SalesTaxExceptionsReport = {
  from: '2026-01-01',
  to: '2026-10-08',
  counts: {
    no_ship_to_state: 1,
    tax_in_unregistered_state: 1,
    taxable_without_tax: 0,
    marketplace_sale: 0,
    tax_override: 1,
    provider_commit_failure: 0,
    tax_warning: 0,
  },
  exceptions: [
    exception(),
    exception({ kind: 'tax_in_unregistered_state', documentId: 'inv_2', documentNumber: 'INV-2', stateCode: 'CO', taxAmount: 12, message: 'Tax was charged in CO, where the business has no registration.' }),
    exception({ kind: 'tax_override', severity: 'warning', documentId: 'inv_3', documentNumber: 'INV-3', message: 'Tax set by hand on "Widget": rounding.' }),
  ],
};

const reconciliation: ProviderReconciliation = {
  engine: 'avalara',
  applicable: true,
  from: '2026-09-08',
  to: '2026-10-08',
  periods: [{ period: '2026-09', documents: 10, committed: 8, uncommitted: 2, providerTax: 500, ledgerTax: 495, difference: -5, problems: 2 }],
  documents: [
    {
      documentType: 'invoice',
      documentId: 'inv_7',
      documentNumber: 'INV-7',
      date: '2026-09-20',
      engine: 'avalara',
      engineRef: 'AV-123',
      committedAt: null,
      providerTax: 50,
      ledgerTax: 45,
      difference: -5,
      status: 'ledger_mismatch',
      severity: 'error',
      message: 'The tax ledger (45.00) differs from the tax the provider calculated (50.00).',
    },
    {
      documentType: 'invoice',
      documentId: 'inv_8',
      documentNumber: 'INV-8',
      date: '2026-09-21',
      engine: 'avalara',
      engineRef: null,
      committedAt: null,
      providerTax: 10,
      ledgerTax: 10,
      difference: 0,
      status: 'missing_commit',
      severity: 'error',
      message: 'The document was never committed to Avalara.',
    },
  ],
  notes: ['x'],
};

function serve(overrides: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    '/sales-tax/reports/liability': liability,
    '/sales-tax/reports/sales-summary': summary,
    '/sales-tax/reports/exceptions': exceptionsReport,
    '/sales-tax/reports/provider-reconciliation': reconciliation,
    ...overrides,
  };
  api.get.mockImplementation(async (path: string) => {
    const key = path.split('?')[0]!;
    if (key in answers) return { data: answers[key] };
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  serve();
});

describe('Liability report', () => {
  it('shows what is collected, filed, paid and owed per agency and in total', async () => {
    renderWithProviders(<SalesTaxReportsPage />);

    const wa = await screen.findByTestId('liability-agency-WA');
    expect(wa).toHaveTextContent('Washington Department of Revenue');
    expect(wa).toHaveTextContent('$1500.00');
    expect(wa).toHaveTextContent('$800.00');
    expect(wa).toHaveTextContent('Ties to the ledger');
    // The agency whose payable account does not tie to the tax ledger shows the difference.
    expect(screen.getByTestId('liability-agency-TX')).toHaveTextContent('$25.50');
    expect(screen.getByTestId('liability-agency-TX')).not.toHaveTextContent('Ties to the ledger');
  });

  it('expands an agency into its jurisdictions', async () => {
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    const wa = await screen.findByTestId('liability-agency-WA');
    expect(screen.queryByText('Seattle')).not.toBeInTheDocument();
    await user.click(within(wa).getByRole('button', { name: 'Show jurisdictions' }));
    expect(await screen.findByText('Seattle')).toBeInTheDocument();
  });

  it('asks the server for the date the user picks', async () => {
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await screen.findByTestId('liability-agency-WA');
    // Until a date is picked the server answers for today, and the report says which day that is.
    expect(screen.getByText('As of 2026-10-08')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/sales-tax/reports/liability');
    await user.type(screen.getByLabelText('As of'), '2026-06-30');

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/sales-tax/reports/liability?asOf=2026-06-30'));
  });

  it('says so when there are no agencies', async () => {
    serve({ '/sales-tax/reports/liability': { ...liability, agencies: [] } });
    renderWithProviders(<SalesTaxReportsPage />);
    expect(await screen.findByText('No agencies yet')).toBeInTheDocument();
  });
});

describe('Sales summary report', () => {
  it('lists the sales by state with a total, starting at the beginning of the year', async () => {
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Sales summary' }));

    const rows = await screen.findAllByTestId('sales-summary-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('WA');
    expect(rows[0]).toHaveTextContent('$9000.00');
    expect(screen.getByTestId('sales-summary-total')).toHaveTextContent('$10000.00');
    expect(api.get).toHaveBeenCalledWith('/sales-tax/reports/sales-summary?from=2026-01-01&to=2026-10-08&groupBy=state');
  });

  it('groups by customer on request', async () => {
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Sales summary' }));
    await screen.findAllByTestId('sales-summary-row');
    await user.click(screen.getByLabelText('Group by'));
    await user.click(await screen.findByRole('option', { name: 'Customer' }));

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/sales-tax/reports/sales-summary?from=2026-01-01&to=2026-10-08&groupBy=customer'),
    );
  });

  it('breaks the exempt sales of a row down by reason', async () => {
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Sales summary' }));
    const [wa] = await screen.findAllByTestId('sales-summary-row');
    await user.click(within(wa!).getByRole('button', { name: 'Exempt sales by reason' }));

    expect(await screen.findByText('Resale: $500.00')).toBeInTheDocument();
    expect(screen.getByText('Government: $200.00')).toBeInTheDocument();
  });
});

describe('Exceptions report', () => {
  it('counts the kinds and filters by one of them', async () => {
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Exceptions' }));
    expect(await screen.findAllByTestId('exception-row')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'All (3)' })).toHaveAttribute('aria-pressed', 'true');
    // Only the kinds that occur get a filter.
    expect(screen.queryByRole('button', { name: /Marketplace sale/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tax in an unregistered state (1)' }));
    const rows = screen.getAllByTestId('exception-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('INV-2');
    expect(rows[0]).toHaveTextContent('CO');
  });

  it('links each exception to its document and says it in our words', async () => {
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Exceptions' }));
    const [first, , third] = await screen.findAllByTestId('exception-row');
    expect(within(first!).getByRole('link', { name: 'INV-1' })).toHaveAttribute('href', '/weldbooks/invoices/inv_1');
    expect(first).toHaveTextContent('so the tax cannot be sourced');
    // A message that names something specific (a user's reason) is shown as the server wrote it.
    expect(third).toHaveTextContent('Tax set by hand on "Widget": rounding.');
  });

  it('says every document is fine when there is nothing to report', async () => {
    serve({ '/sales-tax/reports/exceptions': { ...exceptionsReport, exceptions: [] } });
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Exceptions' }));
    expect(await screen.findByText('No exceptions in this range')).toBeInTheDocument();
  });

  it('filters a list by kind', () => {
    const all = [exception(), exception({ kind: 'tax_override' })];
    expect(filterExceptions(all, 'all')).toHaveLength(2);
    expect(filterExceptions(all, 'tax_override').map((e) => e.kind)).toEqual(['tax_override']);
  });
});

describe('Provider reconciliation report', () => {
  it('shows the months and the documents that need attention with their status', async () => {
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Provider reconciliation' }));

    const month = await screen.findByTestId('reconciliation-period');
    expect(month).toHaveTextContent('2026-09');
    expect(month).toHaveTextContent('$500.00');
    expect(month).toHaveTextContent('$495.00');
    expect(month).toHaveTextContent('$-5.00');

    const documents = screen.getAllByTestId('reconciliation-document');
    expect(documents[0]).toHaveTextContent('Ledger differs');
    expect(documents[1]).toHaveTextContent('Not committed');
    expect(documents[0]).toHaveTextContent('AV-123');
    expect(screen.getByText('Avalara AvaTax')).toBeInTheDocument();
  });

  it('asks for every document when the switch is on', async () => {
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Provider reconciliation' }));
    await screen.findByTestId('reconciliation-period');
    await user.click(screen.getByRole('switch', { name: 'Show every document' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/provider-reconciliation\?.*all=1/)));
  });

  it('explains there is nothing to reconcile with the manual engine', async () => {
    serve({ '/sales-tax/reports/provider-reconciliation': { ...reconciliation, engine: 'manual', applicable: false, periods: [], documents: [] } });
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Provider reconciliation' }));
    expect(await screen.findByText('No provider to reconcile')).toBeInTheDocument();
  });

  it('says every document matches when none needs attention', async () => {
    serve({ '/sales-tax/reports/provider-reconciliation': { ...reconciliation, documents: [] } });
    renderWithProviders(<SalesTaxReportsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Provider reconciliation' }));
    expect(await screen.findByText('Every document matches the provider')).toBeInTheDocument();
  });
});
