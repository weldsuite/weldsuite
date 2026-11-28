import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  can: { 'invoices:update': true, 'invoices:create': true } as Record<string, boolean>,
  entities: [{ id: 'ent_1', name: 'Acme B.V.' }] as Array<{ id: string; name: string }>,
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  salesApi: { getQuote: vi.fn(), emailQuote: vi.fn(), revokeQuoteLink: vi.fn(), invoiceFromQuote: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => env.can[key] ?? false }));
vi.mock('@weldsuite/ui/components/entity-detail-view', () => ({
  EntityDetailView: ({ title, actions, subheader, tabs, children }: { title: ReactNode; actions: ReactNode; subheader: ReactNode; tabs: ReactNode; children: ReactNode }) => (
    <div>
      <header>
        <div data-testid="title">{title}</div>
        {actions}
      </header>
      {subheader}
      {tabs}
      <main>{children}</main>
    </div>
  ),
}));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ label, type, id }: { label: string; type: string; id: string }) => (
    <a href={`#${type}:${id}`}>{label}</a>
  ),
}));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => <div data-testid="audit" data-entity-type={entityType} data-entity-id={entityId} />,
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@/hooks/queries/use-accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-accounting-queries')>()),
  useAccountingCustomer: () => ({ data: { data: { id: 'c_1', email: 'klant@example.test' } } }),
}));
vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ entityId: 'ent_1' }) }));
vi.mock('@/hooks/use-current-entity-currency', () => ({ useAccountingEntities: () => ({ data: env.entities }) }));
vi.mock('@/lib/weldbooks/use-entity-invoice-details', () => ({
  useEntityInvoiceDetails: () => ({ entity: { id: 'ent_1', name: 'Acme B.V.' }, missing: [], labels: {}, isLoading: false }),
}));
vi.mock('@/lib/api/domains/weldbooks-sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-sales')>()),
  salesApi: env.salesApi,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `€${Number(value ?? 0).toFixed(2)}`,
    formatNumber: (value: unknown) => String(value),
    formatDate: (value: string | null | undefined) => value ?? '-',
    formatDateTime: (value: string | null | undefined) => `at ${value}`,
  }),
}));

import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';
import { QuotePanel } from './quote-panel';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

const quote = (overrides: Record<string, unknown> = {}) => ({
  id: 'q_1',
  quoteNumber: 'OFF-12',
  name: 'Nieuwe website',
  contactId: 'c_1',
  contactName: 'Jansen Bouw',
  total: '1210.00',
  subtotal: '1000.00',
  discount: '0.00',
  tax: '210.00',
  currency: 'EUR',
  status: 'sent',
  validUntil: '2026-12-31',
  validFrom: null,
  paymentTerms: '14 dagen',
  termsAndConditions: null,
  notes: null,
  sentAt: '2026-11-03T09:00:00Z',
  viewedAt: '2026-11-04T09:00:00Z',
  acceptedAt: null,
  signedBy: null,
  signedAt: null,
  opportunityId: null,
  createdAt: '2026-11-01T09:00:00Z',
  updatedAt: '2026-11-03T09:00:00Z',
  invoiceIds: [],
  lines: [
    { id: 'l1', description: 'Ontwerp', quantity: '2', unitPrice: '300.00', lineTotal: '600.00', taxRate: '21' },
    { id: 'l2', description: 'Bouw', quantity: '1', unitPrice: '400.00', lineTotal: '400.00' },
  ],
  invoices: [],
  ...overrides,
});

function renderPanel() {
  return renderWithProviders(<QuotePanel id="q_1" isOpen onClose={vi.fn()} />);
}

describe('QuotePanel', () => {
  beforeEach(() => {
    setRuntimeConfig(RUST);
    env.can = { 'invoices:update': true, 'invoices:create': true };
    env.entities = [{ id: 'ent_1', name: 'Acme B.V.' }];
    for (const fn of Object.values(env.salesApi)) fn.mockReset();
    env.salesApi.getQuote.mockResolvedValue({ data: quote() });
    env.toast.success.mockReset();
    env.toast.error.mockReset();
    env.push.mockReset();
    panelOpen.mockReset();
  });
  afterEach(() => setRuntimeConfig(null));

  it('shows the number, its status and the figures, with the customer as a link', async () => {
    renderPanel();
    const title = await screen.findByTestId('title');
    await waitFor(() => expect(title).toHaveTextContent('OFF-12'));
    expect(title).toHaveTextContent('Sent');
    expect(screen.getByText('€1210.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Jansen Bouw' })).toHaveAttribute('href', '#weldbooks_contact:c_1');
    expect(screen.getByText('2026-12-31')).toBeInTheDocument();
    expect(screen.getByText('14 dagen')).toBeInTheDocument();
  });

  it('tells what happened: created, e-mailed, viewed, accepted by whom, and the invoices made', async () => {
    env.salesApi.getQuote.mockResolvedValue({
      data: quote({
        status: 'invoiced',
        acceptedAt: '2026-11-05T09:00:00Z',
        signedBy: 'Piet Jansen',
        invoices: [{ id: 'inv_1', invoiceNumber: 'F-9', status: 'paid', type: 'invoice', total: '605.00', subtotal: '500.00', currency: 'EUR', issueDate: '2026-11-06', entityId: 'ent_1' }],
      }),
    });
    renderPanel();
    const timeline = await screen.findByRole('list', { name: 'What happened' });
    const items = within(timeline).getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual([
      expect.stringContaining('Created'),
      expect.stringContaining('E-mailed'),
      expect.stringContaining('Viewed online'),
      expect.stringContaining('Accepted by Piet Jansen'),
      expect.stringContaining('Invoice F-9 made'),
    ]);
    expect(within(screen.getByTestId('quote-invoices')).getByRole('link', { name: 'F-9' })).toHaveAttribute('href', '#invoice:inv_1');
  });

  it('lists the lines with the totals on the Lines tab', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /Lines/ }));
    expect(await screen.findByText('Ontwerp')).toBeInTheDocument();
    expect(screen.getByText('Bouw')).toBeInTheDocument();
    expect(screen.getByText('Subtotal').nextElementSibling).toHaveTextContent('€1000.00');
    expect(screen.getByText('Tax').nextElementSibling).toHaveTextContent('€210.00');
  });

  it('opens the audit trail of the quote on the History tab', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /History|Audit/i }));
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-type', 'quote');
  });

  describe('Send', () => {
    it('e-mails the quote to the customer’s address and shows the link', async () => {
      const user = userEvent.setup();
      env.salesApi.emailQuote.mockResolvedValue({
        data: { id: 'q_1', status: 'sent', sentAt: null, delivery: { messageId: 'm', to: ['klant@example.test'], subject: 'Offerte', link: 'https://pay.example.test/d/q' } },
      });
      renderPanel();
      await user.click(await screen.findByRole('button', { name: 'Send' }));
      expect(screen.getByRole('heading', { name: 'Send quote' })).toBeInTheDocument();
      expect(screen.getByLabelText('To')).toHaveValue('klant@example.test');
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(env.salesApi.emailQuote).toHaveBeenCalledWith('q_1', { to: ['klant@example.test'], attachPdf: true, includeLink: true }),
      );
      expect(await screen.findByLabelText('Online link')).toHaveValue('https://pay.example.test/d/q');
    });

    it('is not offered to a member who may not update invoices', async () => {
      env.can['invoices:update'] = false;
      renderPanel();
      await screen.findByTestId('title');
      await waitFor(() => expect(screen.getByTestId('title')).toHaveTextContent('OFF-12'));
      expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit quote' })).not.toBeInTheDocument();
    });
  });

  describe('Revoke link', () => {
    it('asks first, then withdraws the link', async () => {
      const user = userEvent.setup();
      env.salesApi.revokeQuoteLink.mockResolvedValue({ data: { id: 'q_1', linkRevoked: true } });
      renderPanel();
      await user.click(await screen.findByRole('button', { name: 'More actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Revoke link' }));
      expect(env.salesApi.revokeQuoteLink).not.toHaveBeenCalled();
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Revoke the online link?');
      await user.click(within(dialog).getByRole('button', { name: 'Revoke link' }));
      await waitFor(() => expect(env.salesApi.revokeQuoteLink).toHaveBeenCalledWith('q_1'));
    });

    it('is not offered for a quote that was never sent', async () => {
      const user = userEvent.setup();
      env.salesApi.getQuote.mockResolvedValue({ data: quote({ status: 'draft', sentAt: null, viewedAt: null }) });
      renderPanel();
      await user.click(await screen.findByRole('button', { name: 'More actions' }));
      expect(screen.queryByRole('menuitem', { name: 'Revoke link' })).not.toBeInTheDocument();
    });
  });

  describe('Make invoice', () => {
    it('makes an invoice for the whole quote and opens the draft in a stacked panel', async () => {
      const user = userEvent.setup();
      env.salesApi.invoiceFromQuote.mockResolvedValue({ data: { id: 'inv_new', quoteId: 'q_1' } });
      renderPanel();
      await user.click(await screen.findByRole('button', { name: 'Make invoice' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('radio', { name: 'The whole quote (100%)' })).toBeChecked();
      // One entity: no choice of legal entity.
      expect(within(dialog).queryByLabelText('Invoice from')).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Make invoice' }));
      await waitFor(() => expect(env.salesApi.invoiceFromQuote).toHaveBeenCalledWith('q_1', {}));
      await waitFor(() => expect(panelOpen).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_new', stack: true }));
    });

    it('makes an advance invoice for a percentage, from the chosen entity when there is more than one', async () => {
      const user = userEvent.setup();
      env.entities = [{ id: 'ent_1', name: 'Acme B.V.' }, { id: 'ent_2', name: 'Acme Holding' }];
      env.salesApi.invoiceFromQuote.mockResolvedValue({ data: { id: 'inv_new' } });
      renderPanel();
      await user.click(await screen.findByRole('button', { name: 'Make invoice' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('radio', { name: 'A share of the quote' }));
      const percentage = within(dialog).getByLabelText('Percentage of the quote');
      await user.clear(percentage);
      await user.type(percentage, '30');
      expect(within(dialog).getByLabelText('Invoice from')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Make invoice' }));
      await waitFor(() => expect(env.salesApi.invoiceFromQuote).toHaveBeenCalledWith('q_1', { entityId: 'ent_1', percentage: 30 }));
    });

    it('refuses a percentage outside 1 to 100 before asking the server', async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(await screen.findByRole('button', { name: 'Make invoice' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('radio', { name: 'A share of the quote' }));
      const percentage = within(dialog).getByLabelText('Percentage of the quote');
      await user.clear(percentage);
      await user.type(percentage, '150');
      expect(within(dialog).getByRole('button', { name: 'Make invoice' })).toBeDisabled();
    });

    it('says how much is left when the server finds it is too much', async () => {
      const user = userEvent.setup();
      env.salesApi.getQuote.mockResolvedValue({
        data: quote({
          status: 'accepted',
          invoices: [{ id: 'i1', invoiceNumber: 'F-1', status: 'sent', type: 'invoice', total: '847.00', subtotal: '700.00', currency: 'EUR', issueDate: '2026-11-06', entityId: 'ent_1' }],
        }),
      });
      env.salesApi.invoiceFromQuote.mockRejectedValue(Object.assign(new Error('too much'), { status: 409 }));
      renderPanel();
      await user.click(await screen.findByRole('button', { name: 'Make invoice' }));
      const dialog = await screen.findByRole('dialog');
      // A quote with an invoice already starts at what is left.
      expect(within(dialog).getByLabelText('Percentage of the quote')).toHaveValue(30);
      await user.click(within(dialog).getByRole('button', { name: 'Make invoice' }));
      await waitFor(() =>
        expect(env.toast.error).toHaveBeenCalledWith('The invoice could not be made', {
          description: 'That is more than what is left of the quote (about 30%).',
        }),
      );
    });

    it('is hidden for a declined or expired quote and for a member who may not create invoices', async () => {
      env.salesApi.getQuote.mockResolvedValue({ data: quote({ status: 'declined' }) });
      const first = renderPanel();
      await waitFor(() => expect(screen.getByTestId('title')).toHaveTextContent('Declined'));
      expect(screen.queryByRole('button', { name: 'Make invoice' })).not.toBeInTheDocument();
      first.unmount();

      env.salesApi.getQuote.mockResolvedValue({ data: quote() });
      env.can['invoices:create'] = false;
      renderPanel();
      await waitFor(() => expect(screen.getByTestId('title')).toHaveTextContent('Sent'));
      expect(screen.queryByRole('button', { name: 'Make invoice' })).not.toBeInTheDocument();
    });
  });

  it('opens the form to edit a quote that can still change, and not an accepted one', async () => {
    const user = userEvent.setup();
    const first = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit quote' }));
    expect(env.push).toHaveBeenCalledWith('/weldbooks/quotes/q_1/edit');
    first.unmount();

    env.salesApi.getQuote.mockResolvedValue({ data: quote({ status: 'accepted', acceptedAt: '2026-11-05T09:00:00Z' }) });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('title')).toHaveTextContent('Accepted'));
    expect(screen.queryByRole('button', { name: 'Edit quote' })).not.toBeInTheDocument();
  });

  it('says so when the quote is gone', async () => {
    env.salesApi.getQuote.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    renderPanel();
    expect(await screen.findByText('Quote not found.')).toBeInTheDocument();
  });
});
