import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { setRuntimeConfig } from '@/lib/runtime-config';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const env = vi.hoisted(() => ({ search: {} as { customerId?: string; projectId?: string }, open: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({ useSearch: () => env.search }),
}));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink };
});
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.open }),
  useObjectPanelUrlSync: vi.fn(),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined) => `€${Number(value ?? 0).toFixed(2)}`,
    formatNumber: (value: string | number | null | undefined) => String(Number(value ?? 0)),
    formatDate: (value: string | null | undefined) => `d:${value ?? ''}`,
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import UnbilledTimePage from './page';
import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const copy = en.weldbooksContactPage.unbilled;
const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

function entry(id: string, date: string, user: string, hours: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    date,
    userId: `u_${user}`,
    userName: user,
    description: `Work ${id}`,
    activity: 'Design',
    hours,
    rate: '95.00',
    amount: (Number(hours) * 95).toFixed(2),
    rateSource: 'project',
    ...extra,
  };
}

const vanDijk = {
  customer: { contactId: 'prt_1', name: 'Van Dijk Architecten' },
  hours: '12.5',
  amount: '1187.50',
  currency: 'EUR',
  projects: [
    {
      projectId: 'prj_1',
      name: 'Renovatie kantoor',
      hours: '12.5',
      amount: '1187.50',
      entries: [entry('te_1', '2026-11-24', 'Eva', '4'), entry('te_2', '2026-11-25', 'Tom', '4.5'), entry('te_3', '2026-11-26', 'Eva', '4')],
    },
  ],
};
const acme = {
  customer: { contactId: 'prt_2', name: 'Acme Logistics BV' },
  hours: '6',
  amount: '570.00',
  currency: 'EUR',
  projects: [{ projectId: 'prj_2', name: 'Warehouse signage', hours: '6', amount: '570.00', entries: [entry('te_9', '2026-11-20', 'Eva', '6')] }],
};

function serve(customers: unknown[] = [vanDijk, acme], extra: (path: string) => unknown = () => undefined) {
  api.get.mockImplementation(async (path: string) => {
    const custom = extra(path);
    if (custom !== undefined) return custom;
    if (path.startsWith('/accounting-time/unbilled')) return { data: customers };
    if (path.startsWith('/invoices')) return { data: [], pagination: { totalCount: 0, hasMore: false } };
    return { data: [] };
  });
}

const draft = (id: string, number: string | null, total: string, currency = 'EUR') => ({
  id,
  invoiceNumber: number,
  status: 'draft',
  type: 'invoice',
  currency,
  total,
  issueDate: '2026-11-01',
});

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  env.open.mockReset();
  env.search = {};
  toast.success.mockReset();
  toast.error.mockReset();
  setRuntimeConfig(RUST);
  permissions.allowed = new Set(['invoices:create', 'time:read']);
});
afterEach(() => setRuntimeConfig(null));

describe('Unbilled time: the customers and their hours', () => {
  it('lists the customers with their hours and amount, and shows the first one’s hours by project, all ticked', async () => {
    serve();
    renderWithProviders(<UnbilledTimePage />);
    const list = await screen.findByRole('navigation', { name: copy.customers });
    expect(within(list).getByText('Van Dijk Architecten')).toBeInTheDocument();
    expect(within(list).getByText('12.5 h')).toBeInTheDocument();
    expect(within(list).getByText('€1187.50')).toBeInTheDocument();
    expect(within(list).getByText('Acme Logistics BV')).toBeInTheDocument();
    expect(within(list).getAllByText('1 project')).toHaveLength(2);

    const table = await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    expect(within(table).getByText('Renovatie kantoor')).toBeInTheDocument();
    expect(within(table).getByText('· rate €95.00 an hour from the project')).toBeInTheDocument();
    const boxes = within(table).getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    for (const box of boxes) expect(box).toBeChecked();
    expect(screen.getByText('3 of 3 hours selected')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/accounting-time/unbilled');
  });

  it('shows another customer’s hours when it is picked, and opens on the customer the address names', async () => {
    const user = userEvent.setup();
    serve();
    env.search = { customerId: 'prt_2' };
    renderWithProviders(<UnbilledTimePage />);
    expect(await screen.findByRole('table', { name: 'Unbilled hours of Acme Logistics BV' })).toBeInTheDocument();

    await user.click(within(screen.getByRole('navigation', { name: copy.customers })).getByRole('button', { name: /Van Dijk/ }));
    expect(await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' })).toBeInTheDocument();
  });

  it('shows a customer billed in two currencies once per currency', async () => {
    serve([vanDijk, { ...vanDijk, currency: 'USD', hours: '1', amount: '100.00' }]);
    renderWithProviders(<UnbilledTimePage />);
    const list = await screen.findByRole('navigation', { name: copy.customers });
    expect(within(list).getAllByText('Van Dijk Architecten')).toHaveLength(2);
  });

  it('asks only for one project’s hours when the address names it, and says so', async () => {
    serve();
    env.search = { projectId: 'prj_1' };
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('navigation', { name: copy.customers });
    expect(api.get).toHaveBeenCalledWith('/accounting-time/unbilled?projectId=prj_1');
    expect(screen.getByText(copy.filteredByProject)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.clearProject })).toHaveAttribute('href', '/weldbooks/time/unbilled');
  });

  it('says there is nothing to invoice, a failure with a retry, and a lack of access in words', async () => {
    serve([]);
    const first = renderWithProviders(<UnbilledTimePage />);
    expect(await screen.findByText(copy.empty)).toBeInTheDocument();
    first.unmount();

    api.get.mockRejectedValue(new Error('boom'));
    const second = renderWithProviders(<UnbilledTimePage />);
    expect(await screen.findByText(copy.loadFailed)).toBeInTheDocument();
    second.unmount();

    api.get.mockReset();
    permissions.allowed = new Set(['time:read']);
    renderWithProviders(<UnbilledTimePage />);
    expect(await screen.findByText(copy.noPermission)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('Unbilled time: the preview of the invoice lines', () => {
  it('shows the lines the server will make, per project, with the hours and the amount before VAT', async () => {
    serve();
    renderWithProviders(<UnbilledTimePage />);
    const section = await screen.findByRole('region', { name: copy.previewTitle });
    expect(within(section).getByText('Renovatie kantoor · 24–26 Nov · 12.5 h')).toBeInTheDocument();
    expect(within(section).getAllByText('€1187.50').length).toBeGreaterThan(0);
    expect(within(section).getByText(copy.vatNote)).toBeInTheDocument();
    expect(within(section).getByText('12.5 h')).toBeInTheDocument();
  });

  it('follows the ticks: an unticked hour leaves the lines and the totals', async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<UnbilledTimePage />);
    const table = await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    await user.click(within(table).getByRole('checkbox', { name: 'Select the hours of d:2026-11-25, Tom' }));
    const section = (await screen.findByRole('heading', { name: copy.previewTitle })).closest('section') as HTMLElement;
    expect(within(section).getByText('Renovatie kantoor · 24–26 Nov · 8 h')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 hours selected')).toBeInTheDocument();
    expect(within(section).getByText('8 h', { selector: 'dd' })).toBeInTheDocument();
  });

  it('ticks and unticks a whole project at once, and empties the preview when none is ticked', async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<UnbilledTimePage />);
    const table = await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    await user.click(within(table).getByRole('checkbox', { name: 'Select all hours of Renovatie kantoor' }));
    expect(await screen.findByText(copy.previewEmpty)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.createInvoice })).toBeDisabled();
    expect(screen.getByRole('button', { name: copy.addToDraft })).toBeDisabled();

    await user.click(within(table).getByRole('checkbox', { name: 'Select all hours of Renovatie kantoor' }));
    expect(await screen.findByText('3 of 3 hours selected')).toBeInTheDocument();
  });

  it('regroups per person, per activity and per entry like the server does', async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    const section = (await screen.findByRole('heading', { name: copy.previewTitle })).closest('section') as HTMLElement;

    await user.click(screen.getByRole('radio', { name: copy.groupings.person }));
    expect(within(section).getByText('Renovatie kantoor · Eva · 24–26 Nov · 8 h')).toBeInTheDocument();
    expect(within(section).getByText('Renovatie kantoor · Tom · 25 Nov · 4.5 h')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: copy.groupings.activity }));
    expect(within(section).getByText('Renovatie kantoor · Design · 24–26 Nov · 12.5 h')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: copy.groupings.entry }));
    expect(within(section).getByText('Renovatie kantoor · 25 Nov · Work te_2 · 4.5 h')).toBeInTheDocument();
    expect(within(section).getAllByRole('listitem')).toHaveLength(3);
  });

  it('flags hours without a rate, with a link to the project to set one', async () => {
    serve([
      {
        ...vanDijk,
        projects: [
          {
            ...vanDijk.projects[0],
            entries: [entry('te_1', '2026-11-24', 'Eva', '4'), entry('te_2', '2026-11-25', 'Tom', '2', { rate: '0.00', amount: '0.00', rateSource: 'none' })],
          },
        ],
      },
    ]);
    renderWithProviders(<UnbilledTimePage />);
    const table = await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    expect(within(table).getAllByText(copy.noRate).length).toBeGreaterThanOrEqual(2);
    expect(within(table).getByRole('link', { name: copy.setRate })).toHaveAttribute('href', '/weldflow/project/prj_1/settings');
    expect(screen.getByText(copy.noRateHint)).toBeInTheDocument();
  });
});

describe('Unbilled time: creating the invoice', () => {
  it('makes a draft invoice of the ticked hours, with the grouping, and opens it', async () => {
    const user = userEvent.setup();
    serve();
    api.post.mockResolvedValue({ data: { id: 'inv_new', items: [] } });
    renderWithProviders(<UnbilledTimePage />);
    const table = await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    await user.click(within(table).getByRole('checkbox', { name: 'Select the hours of d:2026-11-25, Tom' }));
    await user.click(screen.getByRole('radio', { name: copy.groupings.person }));
    await user.click(screen.getByRole('button', { name: copy.createInvoice }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/invoices/from-time', { timeEntryIds: ['te_1', 'te_3'], grouping: 'person' }),
    );
    await waitFor(() => expect(env.open).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_new' }));
    expect(toast.success).toHaveBeenCalledWith(copy.created, expect.anything());
  });

  it('refreshes the list afterwards, so an hour is never offered twice', async () => {
    const user = userEvent.setup();
    serve();
    api.post.mockResolvedValue({ data: { id: 'inv_new' } });
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    const before = api.get.mock.calls.filter((call) => String(call[0]).startsWith('/accounting-time/unbilled')).length;
    await user.click(screen.getByRole('button', { name: copy.createInvoice }));
    await waitFor(() =>
      expect(api.get.mock.calls.filter((call) => String(call[0]).startsWith('/accounting-time/unbilled')).length).toBeGreaterThan(before),
    );
  });

  it('says the hours were invoiced in the meantime when the server refuses with 409', async () => {
    const user = userEvent.setup();
    serve();
    api.post.mockRejectedValue(
      Object.assign(new Error('Already invoiced'), { status: 409, body: { error: { details: { timeEntryIds: ['te_2'] } } } }),
    );
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    await user.click(screen.getByRole('button', { name: copy.createInvoice }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.alreadyInvoiced));
    expect(env.open).not.toHaveBeenCalled();
  });

  it('says why a 400 refused: different customers or currencies for a new invoice', async () => {
    const user = userEvent.setup();
    serve();
    api.post.mockRejectedValue(Object.assign(new Error('Mixed customers'), { status: 400 }));
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    await user.click(screen.getByRole('button', { name: copy.createInvoice }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.mixed, { description: 'Mixed customers' }));
  });

  it('says another failure in words with the server’s reason', async () => {
    const user = userEvent.setup();
    serve();
    api.post.mockRejectedValue(Object.assign(new Error('Down'), { status: 500 }));
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    await user.click(screen.getByRole('button', { name: copy.createInvoice }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.createFailed, { description: 'Down' }));
  });

  it('does not take more entries than an invoice can hold', async () => {
    const many = Array.from({ length: 501 }, (_, i) => entry(`te_${i}`, '2026-11-24', 'Eva', '1'));
    serve([{ ...vanDijk, projects: [{ ...vanDijk.projects[0], entries: many }] }]);
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    expect(screen.getByText(copy.tooMany)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.createInvoice })).toBeDisabled();
  });
});

describe('Unbilled time: adding to an existing draft', () => {
  it('offers the customer’s drafts in the same currency, and adds the hours to the one chosen', async () => {
    const user = userEvent.setup();
    serve([vanDijk, acme], (path) =>
      path.startsWith('/invoices')
        ? {
            data: [draft('inv_d1', null, '300.00'), draft('inv_d2', 'F-12', '90.00'), draft('inv_usd', 'F-13', '10.00', 'USD')],
            pagination: { totalCount: 3, hasMore: false },
          }
        : undefined,
    );
    api.post.mockResolvedValue({ data: { id: 'inv_d2' } });
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    await user.click(screen.getByRole('button', { name: copy.addToDraft }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('radio', { name: 'Draft without a number · €300.00' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: /F-13/ })).not.toBeInTheDocument();
    expect(api.get.mock.calls.some((call) => /^\/invoices\?.*contactId=prt_1/.test(String(call[0])) && String(call[0]).includes('status=draft'))).toBe(true);

    await user.click(within(dialog).getByRole('radio', { name: 'F-12 · €90.00' }));
    await user.click(within(dialog).getByRole('button', { name: copy.add }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/invoices/from-time', {
        timeEntryIds: ['te_1', 'te_2', 'te_3'],
        grouping: 'project',
        invoiceId: 'inv_d2',
      }),
    );
    await waitFor(() => expect(env.open).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_d2' }));
    expect(toast.success).toHaveBeenCalledWith(copy.appended, expect.anything());
  });

  it('says the customer has no draft invoices', async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    await user.click(screen.getByRole('button', { name: copy.addToDraft }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(copy.noDrafts)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: copy.add })).toBeDisabled();
  });

  it('says why a draft was refused: another customer, another currency, or no longer a draft', async () => {
    const user = userEvent.setup();
    serve([vanDijk], (path) =>
      path.startsWith('/invoices') ? { data: [draft('inv_d1', 'F-1', '10.00')], pagination: { totalCount: 1, hasMore: false } } : undefined,
    );
    api.post.mockRejectedValue(Object.assign(new Error('Not a draft'), { status: 400 }));
    renderWithProviders(<UnbilledTimePage />);
    await screen.findByRole('table', { name: 'Unbilled hours of Van Dijk Architecten' });
    await user.click(screen.getByRole('button', { name: copy.addToDraft }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('radio', { name: 'F-1 · €10.00' });
    await user.click(within(dialog).getByRole('button', { name: copy.add }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.badDraft, { description: 'Not a draft' }));
  });
});
