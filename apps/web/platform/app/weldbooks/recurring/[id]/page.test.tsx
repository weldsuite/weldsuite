import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  recurring: null as unknown,
  generate: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink, useParams: () => ({ id: 'ri_1' }), useNavigate: () => vi.fn() };
});
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink, useRouter: () => ({ push: vi.fn() }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: {
    getRecurringInvoice: async () => ({ data: env.recurring }),
    generateRecurringInvoice: env.generate,
    pauseRecurringInvoice: vi.fn(),
    resumeRecurringInvoice: vi.fn(),
  },
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => value ?? '-',
    formatDateTime: (value: string | null | undefined, empty?: string) => value ?? empty ?? '-',
  }),
}));
vi.mock('@/components/page-loader', () => ({ PageLoader: () => null }));
vi.mock('../components/recurring-invoice-form', () => ({
  RecurringInvoiceForm: () => <div data-testid="recurring-form" />,
}));

import RecurringInvoiceDetailPage from './page';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const template = {
  currency: 'USD',
  items: [
    { description: 'Hosting', quantity: 2, unitPrice: 49.5, taxCode: 'saas', taxUse: 'business', taxIncluded: true },
    { description: 'Setup', quantity: 1, unitPrice: 100 },
  ],
};

describe('RecurringInvoiceDetailPage', () => {
  beforeEach(() => {
    env.recurring = {
      id: 'ri_1',
      name: 'Retainer',
      contactId: 'cus_1',
      frequency: 'monthly',
      dayOfMonth: null,
      nextIssueDate: '2026-04-01',
      endDate: null,
      status: 'active',
      templateData: template,
      autoSend: false,
      autoFinalize: true,
      generatedCount: 1,
      lastGeneratedAt: null,
      lastGeneratedInvoiceId: null,
    };
    env.generate.mockReset();
  });

  it('shows the tax settings of each template line', async () => {
    renderWithProviders(<RecurringInvoiceDetailPage />);
    expect(await screen.findByText('Software as a service · Business use · Tax included')).toBeInTheDocument();
    // A line with the defaults shows no settings.
    expect(screen.getByText('Setup').parentElement).not.toHaveTextContent('·');
  });

  it('shows why an invoice was not finalized when the generated invoice stays a draft', async () => {
    const user = userEvent.setup();
    env.generate.mockResolvedValue({
      data: {
        invoiceId: 'inv_9',
        invoiceNumber: 'INV-0009',
        nextIssueDate: '2026-05-01',
        status: 'active',
        journalEntryId: null,
        finalizeError: 'The sales tax engine could not calculate tax: the provider timed out. The invoice was not posted.',
      },
    });
    renderWithProviders(<RecurringInvoiceDetailPage />);

    await user.click(await screen.findByRole('button', { name: /Generate Now/ }));

    const banner = await screen.findByTestId('finalize-error');
    expect(banner).toHaveTextContent('The sales tax engine could not calculate tax: the provider timed out.');
    expect(banner).toHaveTextContent('The invoice stays a draft.');
    expect(screen.getByRole('link', { name: 'Open the invoice' })).toHaveAttribute('href', '/weldbooks/invoices/inv_9');
  });

  it('shows a sales tax refusal of the generation as a notice with its link', async () => {
    const user = userEvent.setup();
    env.generate.mockRejectedValue(Object.assign(new Error('refused'), { code: 'TAX_RATES_NOT_CONFIGURED', status: 400 }));
    renderWithProviders(<RecurringInvoiceDetailPage />);

    await user.click(await screen.findByRole('button', { name: /Generate Now/ }));

    const notice = await screen.findByTestId('sales-tax-error');
    expect(within(notice).getByRole('link', { name: 'Open sales tax agencies' })).toBeInTheDocument();
  });

  it('shows the plain success line when the invoice was finalized', async () => {
    const user = userEvent.setup();
    env.generate.mockResolvedValue({
      data: { invoiceId: 'inv_9', invoiceNumber: 'INV-0009', nextIssueDate: '2026-05-01', status: 'active', journalEntryId: 'je_1', finalizeError: null },
    });
    renderWithProviders(<RecurringInvoiceDetailPage />);

    await user.click(await screen.findByRole('button', { name: /Generate Now/ }));

    await waitFor(() => expect(screen.getByText(/INV-0009/)).toBeInTheDocument());
    expect(screen.queryByTestId('finalize-error')).not.toBeInTheDocument();
  });

  it('opens the template in the form to edit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecurringInvoiceDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Edit template' }));
    expect(screen.getByTestId('recurring-form')).toBeInTheDocument();
  });
});
