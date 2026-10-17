import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  recurring: null as unknown,
  canUpdate: true,
  generate: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  setMode: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canUpdate }));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@weldsuite/ui/components/drawer-field-settings', () => ({ DrawerFieldSettings: () => null }));
vi.mock('@weldsuite/ui/components/entity-detail-view', () => ({
  EntityDetailView: ({
    title,
    actions,
    subheader,
    tabs,
    children,
  }: {
    title: ReactNode;
    actions: ReactNode;
    subheader: ReactNode;
    tabs: ReactNode;
    children: ReactNode;
  }) => (
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
vi.mock('@/components/object-panel', async () => {
  const mock = await import('@/components/objects/_shared/object-panel-test-mock');
  return {
    ...mock,
    useObjectPanelShell: (options: Parameters<typeof mock.useObjectPanelShell>[0]) => ({
      ...mock.useObjectPanelShell(options),
      setMode: env.setMode,
    }),
  };
});
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit" data-entity-type={entityType} data-entity-id={entityId} />
  ),
}));
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink, useRouter: () => ({ push: vi.fn() }) };
});
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: {
    getRecurringInvoice: async () => {
      if (!env.recurring) throw Object.assign(new Error('not found'), { status: 404 });
      return { data: env.recurring };
    },
    getCustomer: async () => ({ data: { name: 'Globex' } }),
    generateRecurringInvoice: env.generate,
    pauseRecurringInvoice: env.pause,
    resumeRecurringInvoice: env.resume,
  },
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => value ?? '-',
    formatDateTime: (value: string | null | undefined, empty?: string) => value ?? empty ?? '-',
  }),
}));
vi.mock('@/app/weldbooks/recurring/components/recurring-invoice-form', () => ({
  RecurringInvoiceForm: () => <div data-testid="recurring-form" />,
}));

import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { RecurringInvoicePanel } from './recurring-invoice-panel';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const template = {
  currency: 'USD',
  items: [
    { description: 'Hosting', quantity: 2, unitPrice: 49.5, taxCode: 'saas', taxUse: 'business', taxIncluded: true },
    { description: 'Setup', quantity: 1, unitPrice: 100 },
  ],
};

async function renderPanel() {
  const utils = renderWithProviders(<RecurringInvoicePanel id="ri_1" isOpen onClose={vi.fn()} />);
  // The template loads from the API: wait for its name, or for the not-found notice.
  await screen.findByText(env.recurring ? 'Retainer' : 'Recurring invoice not found.');
  return utils;
}

describe('RecurringInvoicePanel', () => {
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
    env.canUpdate = true;
    env.generate.mockReset();
    env.pause.mockReset().mockResolvedValue({ data: {} });
    env.resume.mockReset().mockResolvedValue({ data: {} });
    env.setMode.mockReset();
    panelOpen.mockReset();
  });

  it('shows the name, the status, the customer and the schedule', async () => {
    await renderPanel();

    const title = within(screen.getByTestId('title'));
    expect(title.getByText('Retainer')).toBeInTheDocument();
    expect(title.getByText('Active')).toBeInTheDocument();
    expect(await screen.findByText('Globex')).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('2026-04-01')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('shows the tax settings of each template line', async () => {
    const user = userEvent.setup();
    await renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Template Items' }));
    expect(screen.getByText('Software as a service · Business use · Tax included')).toBeInTheDocument();
    expect(screen.getByText('2 × $49.50')).toBeInTheDocument();
    expect(screen.getByText('$99.00')).toBeInTheDocument();
    // A line with the defaults shows no settings.
    expect(screen.getByText('Setup').parentElement).not.toHaveTextContent('·');
  });

  it('says so when the template has no lines', async () => {
    const user = userEvent.setup();
    env.recurring = { ...(env.recurring as object), templateData: { currency: 'USD', items: [] } };
    await renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Template Items' }));
    expect(screen.getByText('No template items')).toBeInTheDocument();
  });

  it('shows the audit log of the template on its own tab', async () => {
    const user = userEvent.setup();
    await renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Audit Log' }));
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-type', 'recurring_invoice');
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-id', 'ri_1');
  });

  it('pauses an active template and offers no resume', async () => {
    const user = userEvent.setup();
    await renderPanel();

    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(env.pause).toHaveBeenCalledWith('ri_1');
  });

  it('resumes a paused template and offers neither generating nor pausing', async () => {
    const user = userEvent.setup();
    env.recurring = { ...(env.recurring as object), status: 'paused' };
    await renderPanel();

    expect(screen.queryByRole('button', { name: /Generate Now/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(env.resume).toHaveBeenCalledWith('ri_1');
  });

  it('shows why an invoice was not finalized when the generated invoice stays a draft, and opens it in place', async () => {
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
    await renderPanel();

    await user.click(screen.getByRole('button', { name: /Generate Now/ }));

    const banner = await screen.findByTestId('finalize-error');
    expect(banner).toHaveTextContent('The sales tax engine could not calculate tax: the provider timed out.');
    expect(banner).toHaveTextContent('The invoice stays a draft.');
    await user.click(screen.getByRole('button', { name: 'Open the invoice' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_9', stack: true });
  });

  it('shows a sales tax refusal of the generation as a notice with its link', async () => {
    const user = userEvent.setup();
    env.generate.mockRejectedValue(Object.assign(new Error('refused'), { code: 'TAX_RATES_NOT_CONFIGURED', status: 400 }));
    await renderPanel();

    await user.click(screen.getByRole('button', { name: /Generate Now/ }));

    const notice = await screen.findByTestId('sales-tax-error');
    expect(within(notice).getByRole('link', { name: 'Open sales tax agencies' })).toBeInTheDocument();
  });

  it('shows the plain success line when the invoice was finalized', async () => {
    const user = userEvent.setup();
    env.generate.mockResolvedValue({
      data: { invoiceId: 'inv_9', invoiceNumber: 'INV-0009', nextIssueDate: '2026-05-01', status: 'active', journalEntryId: 'je_1', finalizeError: null },
    });
    await renderPanel();

    await user.click(screen.getByRole('button', { name: /Generate Now/ }));

    await waitFor(() => expect(screen.getByText(/INV-0009/)).toBeInTheDocument());
    expect(screen.queryByTestId('finalize-error')).not.toBeInTheDocument();
  });

  it('opens the last generated invoice in place', async () => {
    const user = userEvent.setup();
    env.recurring = { ...(env.recurring as object), lastGeneratedInvoiceId: 'inv_7' };
    await renderPanel();

    await user.click(screen.getByRole('button', { name: 'Open the invoice' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_7', stack: true });
  });

  it('opens the template in the form to edit, in fullscreen', async () => {
    const user = userEvent.setup();
    await renderPanel();

    await user.click(screen.getByRole('button', { name: 'Edit template' }));
    expect(screen.getByTestId('recurring-form')).toBeInTheDocument();
    expect(env.setMode).toHaveBeenCalledWith('fullscreen');
    // The form replaces the tabs and the actions while it is open.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate Now/ })).not.toBeInTheDocument();
  });

  it('offers no edit without permission', async () => {
    env.canUpdate = false;
    await renderPanel();
    expect(screen.queryByRole('button', { name: 'Edit template' })).not.toBeInTheDocument();
  });

  it('says so when the template cannot be found', async () => {
    env.recurring = null;
    await renderPanel();
    expect(screen.getByText('Recurring invoice not found.')).toBeInTheDocument();
  });
});
