import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { setRuntimeConfig } from '@/lib/runtime-config';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ label, type, id }: { label: string; type: string; id: string }) => <a href={`#${type}:${id}`}>{label}</a>,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined, currency?: string | null) => `${currency ?? 'EUR'} ${value ?? '0'}`,
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';
import { CrmFinanceTab, contactPayloadOf, type CrmFinanceTarget } from './crm-finance-tab';

const copy = en.weldbooksContactPage;
const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

const company: CrmFinanceTarget = { kind: 'company', id: 'co_1', name: 'Van Dijk Architecten', email: 'info@vandijk.test', phone: '+31 20 123' };
const person: CrmFinanceTarget = { kind: 'person', id: 'pe_1', name: 'Eva van Dijk', firstName: 'Eva', lastName: 'van Dijk', email: 'eva@vandijk.test' };

const found = {
  contact: { id: 'prt_1', name: 'Van Dijk Architecten' },
  summary: {
    toReceive: [{ currency: 'EUR', amount: '1815.00', count: 1 }],
    overdue: [{ currency: 'EUR', amount: '300.00', count: 1 }],
    toPay: [],
    unappliedCredit: [],
    openQuotes: { count: 1, amount: [{ currency: 'EUR', amount: '4840.00' }] },
  },
};

function serve(byCrm: unknown) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/accounting-contacts/by-crm')) return { data: byCrm };
    if (path.includes('/accounting-contacts/prt_1/invoices')) {
      return {
        data: [
          { id: 'inv_1', invoiceNumber: '2026-0144', status: 'sent', issueDate: '2026-11-20', total: '1815.00', currency: 'EUR', type: 'invoice' },
          { id: 'inv_2', invoiceNumber: null, status: 'draft', issueDate: '2026-11-25', total: '90.00', currency: 'EUR', type: 'invoice' },
        ],
        pagination: { totalCount: 2, hasMore: false },
      };
    }
    if (path.startsWith('/accounting-quotes')) {
      return {
        data: [{ id: 'q_1', quoteNumber: 'Q-2026-040', name: 'Verbouwing', total: '4840.00', currency: 'EUR', status: 'sent', invoiceIds: [] }],
        pagination: { totalCount: 1, hasMore: false },
      };
    }
    return { data: [] };
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  panelOpen.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  setRuntimeConfig(RUST);
  permissions.allowed = new Set(['invoices:read', 'invoices:create']);
});
afterEach(() => setRuntimeConfig(null));

describe('the Finance tab of a company or person, with a WeldBooks contact', () => {
  it('looks the contact up by the company and shows its figures', async () => {
    serve(found);
    renderWithProviders(<CrmFinanceTab target={company} />);
    const toReceive = await screen.findByText(copy.tiles.toReceive);
    expect(toReceive.nextElementSibling).toHaveTextContent('EUR 1815.00');
    expect(screen.getByText(copy.tiles.overdue).nextElementSibling).toHaveTextContent('EUR 300.00');
    expect(screen.getByText(copy.finance.openQuotes, { selector: 'dt' }).nextElementSibling).toHaveTextContent('1');
    expect(api.get).toHaveBeenCalledWith('/accounting-contacts/by-crm?companyId=co_1');
  });

  it('looks a person up by personId', async () => {
    serve(found);
    renderWithProviders(<CrmFinanceTab target={person} />);
    await screen.findByText(copy.tiles.toReceive);
    expect(api.get).toHaveBeenCalledWith('/accounting-contacts/by-crm?personId=pe_1');
  });

  it('lists recent invoices and open quotes as links, and a chip to open the contact in WeldBooks', async () => {
    serve(found);
    renderWithProviders(<CrmFinanceTab target={company} />);
    expect(await screen.findByRole('link', { name: copy.finance.openInWeldbooks })).toHaveAttribute('href', '#weldbooks_contact:prt_1');
    expect(await screen.findByRole('link', { name: '2026-0144' })).toHaveAttribute('href', '#invoice:inv_1');
    expect(screen.getByRole('link', { name: copy.overview.noNumber })).toHaveAttribute('href', '#invoice:inv_2');
    expect(await screen.findByRole('link', { name: 'Q-2026-040' })).toHaveAttribute('href', '#quote:q_1');
  });

  it('shows the figures per currency and says when a section is empty', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/accounting-contacts/by-crm')) return { data: { ...found, summary: { ...found.summary, toReceive: [{ currency: 'EUR', amount: '10.00', count: 1 }, { currency: 'USD', amount: '5.00', count: 1 }] } } };
      return { data: [], pagination: { totalCount: 0, hasMore: false } };
    });
    renderWithProviders(<CrmFinanceTab target={company} />);
    expect(await screen.findByText('+ USD 5.00')).toBeInTheDocument();
    expect(await screen.findByText(copy.finance.noInvoices)).toBeInTheDocument();
    expect(await screen.findByText(copy.finance.noOpenQuotes)).toBeInTheDocument();
  });
});

describe('the Finance tab of a record with no WeldBooks contact', () => {
  it('is calm about it and offers to add the record to WeldBooks', async () => {
    serve(null);
    renderWithProviders(<CrmFinanceTab target={company} />);
    expect(await screen.findByText(copy.finance.noContactTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.finance.noContactDescription)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.finance.addToWeldbooks })).toBeEnabled();
    expect(screen.queryByText(copy.tiles.toReceive)).not.toBeInTheDocument();
  });

  it('creates the contact through the create flow, linked to the company, and opens it', async () => {
    const user = userEvent.setup();
    serve(null);
    api.post.mockResolvedValue({ data: { id: 'prt_9' } });
    renderWithProviders(<CrmFinanceTab target={company} />);
    await user.click(await screen.findByRole('button', { name: copy.finance.addToWeldbooks }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/accounting-contacts', {
        role: 'customer',
        name: 'Van Dijk Architecten',
        email: 'info@vandijk.test',
        phone: '+31 20 123',
        kind: 'company',
        companyId: 'co_1',
        companyName: 'Van Dijk Architecten',
      }),
    );
    await waitFor(() => expect(panelOpen).toHaveBeenCalledWith({ type: 'weldbooks_contact', id: 'prt_9', stack: true }));
  });

  it('links a person by personId with the names the record has', () => {
    expect(contactPayloadOf(person)).toEqual({
      role: 'customer',
      name: 'Eva van Dijk',
      email: 'eva@vandijk.test',
      kind: 'person',
      personId: 'pe_1',
      firstName: 'Eva',
      lastName: 'van Dijk',
    });
  });

  it('opens the contact it already is when the server says it is in the books', async () => {
    const user = userEvent.setup();
    serve(null);
    api.post.mockRejectedValue(
      Object.assign(new Error('Already a contact'), { status: 409, body: { error: { details: { contactId: 'prt_1' } } } }),
    );
    renderWithProviders(<CrmFinanceTab target={company} />);
    await user.click(await screen.findByRole('button', { name: copy.finance.addToWeldbooks }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0]?.[0]).toBe(en.accounting.contacts.alreadyInBooks);
  });

  it('offers no add button to a member who may not create invoices', async () => {
    permissions.allowed = new Set(['invoices:read']);
    serve(null);
    renderWithProviders(<CrmFinanceTab target={company} />);
    expect(await screen.findByText(copy.finance.noContactTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.finance.addToWeldbooks })).not.toBeInTheDocument();
  });
});

describe('the Finance tab without access, and when it fails', () => {
  it('says so, and asks the server nothing, for a member who may not read invoices', () => {
    permissions.allowed = new Set();
    renderWithProviders(<CrmFinanceTab target={company} />);
    expect(screen.getByText(copy.finance.noPermission)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('offers a retry when the contact cannot be loaded', async () => {
    api.get.mockRejectedValue(new Error('boom'));
    renderWithProviders(<CrmFinanceTab target={company} />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(copy.finance.loadFailed)).toBeInTheDocument();
    expect(within(alert).getByRole('button')).toBeInTheDocument();
  });
});
