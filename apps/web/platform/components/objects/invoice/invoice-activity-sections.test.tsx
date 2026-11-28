import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setRuntimeConfig } from '@/lib/runtime-config';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';

const env = vi.hoisted(() => ({
  canUpdate: true,
  toast: { success: vi.fn(), error: vi.fn() },
  paymentsApi: { getConnection: vi.fn() },
  contactPageApi: { invoicePublicLink: vi.fn() },
  salesApi: {
    getReminderSettings: vi.fn(),
    getQuote: vi.fn(),
    revokeInvoiceLink: vi.fn(),
    remindInvoice: vi.fn(),
    setRemindersPaused: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canUpdate }));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/lib/api/domains/weldbooks-sales', () => ({ salesApi: env.salesApi }));
vi.mock('@/lib/api/domains/weldbooks-payments', () => ({ paymentsApi: env.paymentsApi }));
vi.mock('@/lib/api/domains/weldbooks-contact-page', () => ({ contactPageApi: env.contactPageApi }));
vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ entityId: 'ent_1', setEntityId: vi.fn() }) }));
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
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
import { salesKeys } from '@/hooks/queries/use-weldbooks-sales-queries';
import { InvoiceSalesSections } from './invoice-activity-sections';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

const SETTINGS = {
  enabled: true,
  entityId: 'ent_1',
  statutoryAvailable: false,
  statutoryCosts: { enabled: false, interest: false, commercialRate: 10.4, consumerRate: 4 },
  steps: [
    { level: 1, daysAfterDue: 7, auto: true, template: 'reminder1', final: false },
    { level: 2, daysAfterDue: 21, auto: false, template: 'reminder2', final: false },
  ],
};

const history = [
  { type: 'link', at: '2026-11-03T09:20:00Z' },
  { type: 'sent', at: '2026-11-03T09:20:00Z', to: ['klant@example.test'] },
  { type: 'viewed', at: '2026-11-04T10:00:00Z' },
  { type: 'viewed', at: '2026-11-05T10:00:00Z' },
] as const;

function invoice(overrides: Record<string, unknown> = {}): InvoiceWithTax {
  return {
    id: 'inv_1',
    invoiceNumber: 'F-1',
    type: 'invoice',
    status: 'sent',
    currency: 'EUR',
    createdAt: '2026-11-03T09:00:00Z',
    dueDate: '2026-11-10',
    balanceDue: '100.00',
    contactEmail: 'klant@example.test',
    emailHistory: [...history],
    payments: [],
    items: [],
    ...overrides,
  } as unknown as InvoiceWithTax;
}

function renderSections(inv: InvoiceWithTax, props: { isCreditMemo?: boolean } = {}) {
  const onOpenPayments = vi.fn();
  const utils = renderWithProviders(
    <InvoiceSalesSections invoice={inv} isCreditMemo={props.isCreditMemo ?? false} onOpenPayments={onOpenPayments} />,
  );
  return { onOpenPayments, ...utils };
}

describe('InvoiceSalesSections', () => {
  beforeEach(() => {
    env.canUpdate = true;
    for (const fn of Object.values(env.salesApi)) fn.mockReset();
    env.toast.success.mockReset();
    env.toast.error.mockReset();
    env.paymentsApi.getConnection.mockReset();
    env.paymentsApi.getConnection.mockResolvedValue({ data: null });
    env.contactPageApi.invoicePublicLink.mockReset();
    env.contactPageApi.invoicePublicLink.mockResolvedValue({ data: { url: 'https://pay.example.test/d/abc' } });
    env.salesApi.getReminderSettings.mockResolvedValue({ data: SETTINGS });
    env.salesApi.getQuote.mockResolvedValue({ data: { id: 'q_1', quoteNumber: 'OFF-12', name: 'Offerte' } });
    panelOpen.mockReset();
  });
  afterEach(() => setRuntimeConfig(null));

  it('shows nothing where the edition has none of the sales features (Global)', () => {
    setRuntimeConfig(null);
    renderSections(invoice());
    expect(screen.queryByTestId('invoice-sales-sections')).not.toBeInTheDocument();
  });

  describe('What happened', () => {
    it('tells the story: created, e-mailed, viewed with a count, and the next reminder when it is automatic', async () => {
      setRuntimeConfig(RUST);
      renderSections(invoice());
      const timeline = await screen.findByRole('list', { name: 'What happened' });
      // The planned reminder comes with the workflow settings.
      await waitFor(() => expect(within(timeline).getAllByRole('listitem')).toHaveLength(4));
      const items = within(timeline).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining('Created'),
        expect.stringContaining('E-mailedTo klant@example.test'),
        expect.stringContaining('Viewed online 2 times'),
        expect.stringContaining('Reminder 1 is sent automatically'),
      ]);
      expect(items[3]).toHaveAttribute('data-upcoming');
      expect(items[3]).toHaveTextContent('Planned:');
    });

    it('names the quote an invoice was created from', async () => {
      setRuntimeConfig(RUST);
      renderSections(invoice({ quoteId: 'q_1' }));
      expect(await screen.findByText('Created from quote OFF-12')).toBeInTheDocument();
    });

    it('says a bounce, a reminder with what it claims, and a payment', async () => {
      setRuntimeConfig(RUST);
      renderSections(
        invoice({
          status: 'paid',
          balanceDue: '0',
          emailHistory: [
            { type: 'sent', at: '2026-11-03T09:00:00Z', to: ['a@b.test'] },
            { type: 'bounced', at: '2026-11-03T09:01:00Z', to: ['a@b.test'], error: 'mailbox full' },
            { type: 'reminder', at: '2026-11-20T09:00:00Z', level: 3, to: ['a@b.test'], claim: { total: '1161.40', costsDue: true, interest: '11.40' } },
          ],
          payments: [{ id: 'pay_1', date: '2026-11-25', amount: '1161.40' }],
        }),
      );
      expect(await screen.findByText('E-mail bounced')).toBeInTheDocument();
      expect(screen.getByText('To a@b.test · mailbox full')).toBeInTheDocument();
      expect(screen.getByText('Reminder 3 sent')).toBeInTheDocument();
      expect(screen.getByText('To a@b.test · Asks for €1161.40, with collection costs and interest')).toBeInTheDocument();
      expect(screen.getByText('Paid in full, €1161.40')).toBeInTheDocument();
    });
  });

  describe('Online link', () => {
    it('copies the link the server derives, in a browser that never sent the invoice', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      setRuntimeConfig(RUST);
      renderSections(invoice());
      const card = await screen.findByTestId('online-link-card');
      await user.click(await within(card).findByRole('button', { name: 'Copy link' }));
      expect(writeText).toHaveBeenCalledWith('https://pay.example.test/d/abc');
      expect(env.contactPageApi.invoicePublicLink).toHaveBeenCalledWith('inv_1');
      // The old "send again to copy" fallback is gone.
      expect(within(card).queryByRole('button', { name: /send again/i })).not.toBeInTheDocument();
    });

    it('copies the link a send brings back at once, without waiting for the server to be asked again', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      setRuntimeConfig(RUST);
      const { client } = renderSections(invoice());
      const card = await screen.findByTestId('online-link-card');
      await within(card).findByRole('button', { name: 'Copy link' });
      // A send or a reminder answers with the link: the cache takes it.
      act(() => client.setQueryData(salesKeys.link('invoice', 'inv_1'), 'https://pay.example.test/d/new'));
      await user.click(within(card).getByRole('button', { name: 'Copy link' }));
      expect(writeText).toHaveBeenCalledWith('https://pay.example.test/d/new');
    });

    it('offers no copy button while the document has no link', async () => {
      setRuntimeConfig(RUST);
      env.contactPageApi.invoicePublicLink.mockResolvedValue({ data: { url: null } });
      renderSections(invoice());
      const card = await screen.findByTestId('online-link-card');
      await waitFor(() => expect(env.contactPageApi.invoicePublicLink).toHaveBeenCalled());
      expect(within(card).queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    });

    it('revokes the link only after a confirmation', async () => {
      const user = userEvent.setup();
      setRuntimeConfig(RUST);
      env.salesApi.revokeInvoiceLink.mockResolvedValue({ data: { id: 'inv_1', linkRevoked: true } });
      renderSections(invoice());
      const card = await screen.findByTestId('online-link-card');
      await user.click(within(card).getByRole('button', { name: 'Revoke link' }));
      expect(env.salesApi.revokeInvoiceLink).not.toHaveBeenCalled();
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Revoke the online link?');
      await user.click(within(dialog).getByRole('button', { name: 'Revoke link' }));
      await waitFor(() => expect(env.salesApi.revokeInvoiceLink).toHaveBeenCalledWith('inv_1'));
      expect(env.toast.success).toHaveBeenCalledWith('The online link no longer works');
    });

    it('says there is no link yet before the first send, and hides revoking from a member who may not update', async () => {
      env.canUpdate = false;
      setRuntimeConfig(RUST);
      renderSections(invoice({ emailHistory: [] }));
      const card = await screen.findByTestId('online-link-card');
      expect(card).toHaveTextContent('There is no online link yet');
      expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('Reminders', () => {
    it('names the workflow and the next step: automatic', async () => {
      setRuntimeConfig(RUST);
      renderSections(invoice());
      const card = await screen.findByTestId('reminders-card');
      expect(card).toHaveTextContent('Standard workflow');
      await waitFor(() => expect(screen.getByTestId('reminder-status')).toHaveTextContent('Reminder 1 is sent automatically on 2026-11-17.'));
    });

    it('says when the next step is yours to send', async () => {
      setRuntimeConfig(RUST);
      renderSections(invoice({ reminderLevel: 1 }));
      await waitFor(() => expect(screen.getByTestId('reminder-status')).toHaveTextContent('Reminder 2 is due on 2026-12-01. You send it yourself.'));
    });

    it('sends the next reminder now, after a confirmation', async () => {
      const user = userEvent.setup();
      setRuntimeConfig(RUST);
      env.salesApi.remindInvoice.mockResolvedValue({ data: { reminder: { level: 1, to: ['klant@example.test'], messageId: 'm', subject: 's', link: 'https://pay.example.test/d/abc' } } });
      renderSections(invoice());
      const card = await screen.findByTestId('reminders-card');
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Send reminder now' })).toBeEnabled());
      await user.click(within(card).getByRole('button', { name: 'Send reminder now' }));
      expect(env.salesApi.remindInvoice).not.toHaveBeenCalled();
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Send reminder 1 now?');
      await user.click(within(dialog).getByRole('button', { name: 'Send reminder now' }));
      await waitFor(() => expect(env.salesApi.remindInvoice).toHaveBeenCalledWith('inv_1'));
      expect(env.toast.success).toHaveBeenCalledWith('Reminder 1 sent to klant@example.test');
    });

    it('explains a refusal in plain words', async () => {
      const user = userEvent.setup();
      setRuntimeConfig(RUST);
      env.salesApi.remindInvoice.mockRejectedValue(Object.assign(new Error('x'), { status: 400 }));
      renderSections(invoice());
      const card = await screen.findByTestId('reminders-card');
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Send reminder now' })).toBeEnabled());
      await user.click(within(card).getByRole('button', { name: 'Send reminder now' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send reminder now' }));
      await waitFor(() =>
        expect(env.toast.error).toHaveBeenCalledWith('The reminder could not be sent', { description: 'The contact has no e-mail address. Add one first.' }),
      );
    });

    it('pauses and resumes the reminders', async () => {
      const user = userEvent.setup();
      setRuntimeConfig(RUST);
      env.salesApi.setRemindersPaused.mockResolvedValue({ data: {} });
      const first = renderSections(invoice());
      const card = await screen.findByTestId('reminders-card');
      await user.click(within(card).getByRole('button', { name: 'Pause reminders' }));
      await waitFor(() => expect(env.salesApi.setRemindersPaused).toHaveBeenCalledWith('inv_1', true));
      // The invoice comes back from the server paused.
      first.unmount();
      renderSections(invoice({ remindersPaused: true }));
      expect(await screen.findByText('Reminders are paused for this invoice.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Resume reminders' }));
      await waitFor(() => expect(env.salesApi.setRemindersPaused).toHaveBeenLastCalledWith('inv_1', false));
    });

    it('is not shown for a credit note, a draft or an invoice that was never reminded and is paid', async () => {
      setRuntimeConfig(RUST);
      const { unmount } = renderSections(invoice(), { isCreditMemo: true });
      await screen.findByTestId('online-link-card');
      expect(screen.queryByTestId('reminders-card')).not.toBeInTheDocument();
      unmount();

      const draft = renderSections(invoice({ status: 'draft' }));
      expect(draft.container.querySelector('[data-testid="reminders-card"]')).toBeNull();
      expect(draft.container.querySelector('[data-testid="online-link-card"]')).toBeNull();
      draft.unmount();

      renderSections(invoice({ status: 'paid', balanceDue: '0' }));
      await screen.findByTestId('online-link-card');
      expect(screen.queryByTestId('reminders-card')).not.toBeInTheDocument();
    });

    it('is not shown where the edition has no reminders, though the online link is', async () => {
      setRuntimeConfig({ ...RUST, unavailableFeatures: ['books-reminders'] });
      renderSections(invoice());
      await screen.findByTestId('online-link-card');
      expect(screen.queryByTestId('reminders-card')).not.toBeInTheDocument();
    });
  });

  describe('Online payments in the timeline', () => {
    const paidOnline = [
      { type: 'sent', at: '2026-11-03T09:20:00Z', to: ['klant@example.test'] },
      { type: 'payment_started', at: '2026-11-04T10:00:00Z', molliePaymentId: 'tr_1', amount: '100.00' },
      { type: 'payment_status', at: '2026-11-04T10:02:00Z', status: 'paid', method: 'ideal' },
      { type: 'payment_reversed', at: '2026-11-09T10:00:00Z', kind: 'refund', amount: '25.00' },
    ];

    it('says a payment started, was paid with the method, and was refunded', async () => {
      setRuntimeConfig(RUST);
      renderSections(invoice({ emailHistory: paidOnline, status: 'paid', balanceDue: '0' }));
      const timeline = await screen.findByRole('list', { name: 'What happened' });
      expect(within(timeline).getByText('Payment started via the online link')).toBeInTheDocument();
      expect(within(timeline).getByText('Amount €100.00')).toBeInTheDocument();
      expect(within(timeline).getByText('Paid with iDEAL')).toBeInTheDocument();
      expect(within(timeline).getByText('Refunded €25.00')).toBeInTheDocument();
    });

    it('says a failed, expired and cancelled payment, a chargeback, and a method it has no name for', async () => {
      setRuntimeConfig(RUST);
      renderSections(
        invoice({
          emailHistory: [
            { type: 'payment_status', at: '2026-11-04T10:00:00Z', status: 'failed' },
            { type: 'payment_status', at: '2026-11-05T10:00:00Z', status: 'expired' },
            { type: 'payment_status', at: '2026-11-06T10:00:00Z', status: 'canceled' },
            { type: 'payment_status', at: '2026-11-07T10:00:00Z', status: 'paid', method: 'bancontact' },
            { type: 'payment_status', at: '2026-11-08T10:00:00Z', status: 'paid', method: 'somenewmethod' },
            { type: 'payment_reversed', at: '2026-11-09T10:00:00Z', kind: 'chargeback', amount: '100.00' },
          ],
        }),
      );
      const timeline = await screen.findByRole('list', { name: 'What happened' });
      for (const text of ['Payment failed', 'Payment expired', 'Payment cancelled', 'Paid with Bancontact', 'Paid with somenewmethod', 'Chargeback €100.00']) {
        expect(within(timeline).getByText(text)).toBeInTheDocument();
      }
    });
  });

  describe('Online payment card', () => {
    const CONNECTED = {
      id: 'pc_1',
      status: 'active',
      methods: ['ideal', 'bancontact'],
      testmode: false,
      bankAccountId: 'ba_mollie',
    };
    const refunded = [
      { type: 'payment_status', at: '2026-11-04T10:02:00Z', status: 'paid', method: 'ideal' },
      { type: 'payment_reversed', at: '2026-11-09T10:00:00Z', kind: 'refund', amount: '25.00' },
    ];

    it('shows nothing where the edition has no online payments (Global)', async () => {
      setRuntimeConfig({ ...RUST, unavailableFeatures: ['books-online-payments'] });
      renderSections(invoice());
      await screen.findByTestId('online-link-card');
      expect(screen.queryByTestId('online-payment-card')).not.toBeInTheDocument();
      expect(env.paymentsApi.getConnection).not.toHaveBeenCalled();
    });

    it("says customers can pay online with the entity's methods", async () => {
      setRuntimeConfig(RUST);
      env.paymentsApi.getConnection.mockResolvedValue({ data: CONNECTED });
      renderSections(invoice());
      const card = await screen.findByTestId('online-payment-card');
      expect(await within(card).findByText('Customers can pay this invoice online with iDEAL and Bancontact.')).toBeInTheDocument();
      expect(within(card).queryByRole('link', { name: 'Set up online payments' })).not.toBeInTheDocument();
    });

    it("links to the entity's settings, and remembers where to come back to, when Mollie is not connected", async () => {
      const user = userEvent.setup();
      setRuntimeConfig(RUST);
      renderSections(invoice());
      const card = await screen.findByTestId('online-payment-card');
      const link = await within(card).findByRole('link', { name: 'Set up online payments' });
      expect(link).toHaveAttribute('href', '/settings/entities/ent_1/edit');
      expect(card).toHaveTextContent('Customers cannot pay this invoice online yet.');
      window.history.replaceState(null, '', '/weldbooks/invoices');
      // jsdom cannot navigate: only the click matters here.
      link.addEventListener('click', (event) => event.preventDefault());
      await user.click(link);
      expect(sessionStorage.getItem('settings-return-url')).toBe('/weldbooks/invoices');
    });

    it('asks to reconnect when Mollie needs reconnecting', async () => {
      setRuntimeConfig(RUST);
      env.paymentsApi.getConnection.mockResolvedValue({ data: { ...CONNECTED, status: 'needs_reauth' } });
      renderSections(invoice());
      const card = await screen.findByTestId('online-payment-card');
      expect(await within(card).findByText(/Online payments are paused/)).toBeInTheDocument();
      expect(within(card).getByRole('link', { name: 'Reconnect Mollie' })).toBeInTheDocument();
    });

    it('asks to choose a method when none is on', async () => {
      setRuntimeConfig(RUST);
      env.paymentsApi.getConnection.mockResolvedValue({ data: { ...CONNECTED, methods: [] } });
      renderSections(invoice());
      expect(await screen.findByText(/no payment method is chosen/)).toBeInTheDocument();
    });

    it('shows the last payment status and when', async () => {
      setRuntimeConfig(RUST);
      env.paymentsApi.getConnection.mockResolvedValue({ data: CONNECTED });
      renderSections(
        invoice({
          emailHistory: [
            { type: 'payment_started', at: '2026-11-04T10:00:00Z' },
            { type: 'payment_status', at: '2026-11-04T10:02:00Z', status: 'failed', method: 'ideal' },
          ],
        }),
      );
      expect(await screen.findByTestId('online-payment-last')).toHaveTextContent('Last payment: Payment failed on at 2026-11-04T10:02:00Z');
    });

    it('notes that a refund went out through Mollie and links to its lines to process', async () => {
      setRuntimeConfig(RUST);
      env.paymentsApi.getConnection.mockResolvedValue({ data: CONNECTED });
      renderSections(invoice({ status: 'paid', balanceDue: '0', emailHistory: refunded }));
      const note = await screen.findByTestId('online-payment-reversal');
      expect(note).toHaveTextContent('A refund of €25.00 went out through Mollie. The money has left your Mollie account: book it in To process.');
      expect(within(note).getByRole('link', { name: 'Open the Mollie account lines' })).toHaveAttribute('href', '/weldbooks/banking/process');
    });

    it('says a chargeback in its own words', async () => {
      setRuntimeConfig(RUST);
      env.paymentsApi.getConnection.mockResolvedValue({ data: CONNECTED });
      renderSections(
        invoice({
          status: 'paid',
          balanceDue: '0',
          emailHistory: [{ type: 'payment_reversed', at: '2026-11-09T10:00:00Z', kind: 'chargeback', amount: '100.00' }],
        }),
      );
      expect(await screen.findByTestId('online-payment-reversal')).toHaveTextContent('(a chargeback)');
    });

    it('leaves a closed invoice that never saw an online payment alone', async () => {
      setRuntimeConfig(RUST);
      env.paymentsApi.getConnection.mockResolvedValue({ data: CONNECTED });
      renderSections(invoice({ status: 'paid', balanceDue: '0' }));
      await screen.findByTestId('online-link-card');
      expect(screen.queryByTestId('online-payment-card')).not.toBeInTheDocument();
    });

    it('is not shown on a credit note', async () => {
      setRuntimeConfig(RUST);
      renderSections(invoice(), { isCreditMemo: true });
      await screen.findByTestId('online-link-card');
      expect(screen.queryByTestId('online-payment-card')).not.toBeInTheDocument();
    });
  });

  describe('Connections', () => {
    it('chains the quote, the invoice, its payments and their bank lines, each a link', async () => {
      const user = userEvent.setup();
      setRuntimeConfig(RUST);
      const { onOpenPayments } = renderSections(
        invoice({
          quoteId: 'q_1',
          payments: [{ id: 'pay_1', date: '2026-11-06', amount: '100.00', bankTransactionId: 'bt_1' }],
        }),
      );
      const strip = await screen.findByRole('navigation', { name: 'Connections' });
      expect(await within(strip).findByRole('link', { name: /OFF-12/ })).toBeInTheDocument();
      expect(within(strip).getByText('F-1')).toBeInTheDocument();
      // The payment opens the Payments tab; the bank line stacks its panel.
      await user.click(within(strip).getByRole('button', { name: /€100.00/ }));
      expect(onOpenPayments).toHaveBeenCalled();
      expect(within(strip).getAllByRole('link', { name: /€100.00/ })).toHaveLength(1);
    });

    it('is left out when the invoice has no quote and no payments', async () => {
      setRuntimeConfig(RUST);
      renderSections(invoice());
      await screen.findByTestId('online-link-card');
      expect(screen.queryByRole('navigation', { name: 'Connections' })).not.toBeInTheDocument();
    });
  });
});
