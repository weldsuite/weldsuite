import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), getBlob: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? to.replace('$id', params.id ?? '') : to}>{children}</a>
  ),
  useNavigate: () => navigate,
  useParams: () => ({ id: 'txr_1' }),
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string | null) => value ?? '—',
  formatDateTime: (value: string | null) => value ?? '—',
  today: () => '2026-10-20',
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const download = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('@/lib/weldbooks/download', () => download);
vi.mock('../../shared/sales-tax-frame', () => ({
  SalesTaxGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import SalesTaxReturnPage from './page';
import { installPointerPolyfills, makeReturn, renderWithProviders } from '../../shared/test-support';
import type { PreFileCheck, ReturnExceptions, TaxReturnDetail } from '@/lib/api/domains/weldbooks-sales-tax-center';

const ALL = ['taxes:read', 'taxes:create', 'taxes:update', 'taxes:delete', 'taxes:file'];

const cleanCheck: PreFileCheck = {
  returnId: 'txr_1',
  agencyId: 'sta_wa',
  stateCode: 'WA',
  periodStart: '2026-07-01',
  periodEnd: '2026-09-30',
  comparison: null,
  skipped: [],
  findings: [],
  ok: true,
};

const noExceptions: ReturnExceptions = {
  returnId: 'txr_1',
  applicable: true,
  items: [],
  latePayments: [],
  totals: {
    open: { documents: 0, taxAmount: 0 },
    carried_forward: { documents: 0, taxAmount: 0 },
    amended: { documents: 0, taxAmount: 0 },
  },
};

/** Answers the reads of the return page; `ret` is the return, `exceptions` what changed after filing. */
function serve(ret: TaxReturnDetail, exceptions: ReturnExceptions = noExceptions, check: PreFileCheck = cleanCheck) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/tax-returns/txr_1') return { data: ret };
    if (path === '/tax-returns/txr_1/exceptions') return { data: exceptions };
    if (path === '/tax-returns/txr_1/pre-file-check') return { data: check };
    if (path.startsWith('/bank-accounts')) return { data: [] };
    return { data: [] };
  });
}

const steps = () => screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-state'));
const stepStates = () => steps().map((li) => li.getAttribute('data-state'));

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of [api.get, api.post, api.patch, api.delete, api.getBlob, navigate, toast.success, toast.error, download.downloadBlob]) fn.mockReset();
  permissions.allowed = new Set(ALL);
  serve(makeReturn());
  api.post.mockResolvedValue({ data: makeReturn() });
});

describe('an open return', () => {
  const open = makeReturn({ status: 'open', summary: null, lines: null, adjustments: [], totalDue: 0 });

  it('is at the calculate step and offers to calculate', async () => {
    serve(open);
    renderWithProviders(<SalesTaxReturnPage />);

    expect(await screen.findByRole('heading', { name: 'Washington Department of Revenue return' })).toBeInTheDocument();
    expect(stepStates()).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(screen.getByText('Not calculated yet')).toBeInTheDocument();
    expect(screen.queryByTestId('worksheet-card')).not.toBeInTheDocument();
  });

  it('calculates it', async () => {
    serve(open);
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    const buttons = await screen.findAllByRole('button', { name: 'Calculate return' });
    await user.click(buttons[0]!);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tax-returns/txr_1/calculate'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Return calculated'));
  });

  it('does not offer to calculate to someone who cannot update returns', async () => {
    permissions.allowed = new Set(['taxes:read']);
    serve(open);
    renderWithProviders(<SalesTaxReturnPage />);

    await screen.findByText('Not calculated yet');
    expect(screen.queryByRole('button', { name: 'Calculate return' })).not.toBeInTheDocument();
  });
});

describe('a calculated return', () => {
  it('shows the worksheet and the total due, and is at the review step', async () => {
    renderWithProviders(<SalesTaxReturnPage />);

    expect(await screen.findByTestId('worksheet-card')).toBeInTheDocument();
    expect(screen.getByTestId('ws-total-tax-due')).toHaveTextContent('$824.38');
    expect(screen.getByTestId('total-due')).toHaveTextContent('$824.38');
    expect(stepStates()).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
    expect(screen.getByText(/2026-07-01 to 2026-09-30/)).toBeInTheDocument();
  });

  it('marks it as reviewed', async () => {
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Mark as reviewed' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tax-returns/txr_1/review'));
    expect(screen.queryByRole('button', { name: 'File return' })).not.toBeInTheDocument();
  });

  it('can be calculated again', async () => {
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Recalculate' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tax-returns/txr_1/calculate'));
  });

  it('exports the worksheet as a CSV file', async () => {
    api.getBlob.mockResolvedValue({ blob: new Blob(['a,b']), filename: 'sales-tax-wa.csv' });
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(api.getBlob).toHaveBeenCalledWith('/tax-returns/txr_1/export?format=csv'));
    await waitFor(() => expect(download.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'sales-tax-wa.csv'));
  });

  it('names the file itself when the server gives no name', async () => {
    api.getBlob.mockResolvedValue({ blob: new Blob(['a,b']), filename: null });
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(download.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'sales-tax-wa-2026-07-01-2026-09-30.csv'));
  });

  it('deletes it after confirmation and goes back to the returns', async () => {
    api.delete.mockResolvedValue(undefined);
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Delete return' }));
    expect(screen.getByText('Delete this return?')).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete return' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/tax-returns/txr_1'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/returns' }));
  });

  it('hides delete from someone without that permission', async () => {
    permissions.allowed = new Set(['taxes:read', 'taxes:update']);
    renderWithProviders(<SalesTaxReturnPage />);

    await screen.findByTestId('worksheet-card');
    expect(screen.queryByRole('button', { name: 'Delete return' })).not.toBeInTheDocument();
  });

  it('shows the state portal when the agency has one', async () => {
    renderWithProviders(<SalesTaxReturnPage />);
    expect(await screen.findByRole('link', { name: 'Open state portal' })).toHaveAttribute('href', 'https://dor.wa.gov');
  });

  it('marks an overdue return', async () => {
    serve(makeReturn({ overdue: true, dueDate: '2026-10-10' }));
    renderWithProviders(<SalesTaxReturnPage />);
    expect(await screen.findByText('Overdue')).toBeInTheDocument();
  });
});

describe('a reviewed return', () => {
  it('is at the pre-file check until the check is clean, then at the filing', async () => {
    serve(makeReturn({ status: 'reviewed' }));
    renderWithProviders(<SalesTaxReturnPage />);

    await screen.findByTestId('worksheet-card');
    await waitFor(() => expect(stepStates()).toEqual(['done', 'done', 'done', 'current', 'todo']));
  });

  it('stays at the pre-file check while the check has findings', async () => {
    serve(makeReturn({ status: 'reviewed' }), noExceptions, { ...cleanCheck, ok: false, findings: [] });
    renderWithProviders(<SalesTaxReturnPage />);

    await screen.findByTestId('worksheet-card');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/tax-returns/txr_1/pre-file-check'));
    expect(stepStates()).toEqual(['done', 'done', 'current', 'todo', 'todo']);
  });

  it('opens the filing dialog', async () => {
    serve(makeReturn({ status: 'reviewed' }));
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'File return' }));
    expect(await screen.findByLabelText('Confirmation number')).toBeInTheDocument();
  });

  it('does not offer filing to someone without the filing permission', async () => {
    permissions.allowed = new Set(['taxes:read', 'taxes:update']);
    serve(makeReturn({ status: 'reviewed' }));
    renderWithProviders(<SalesTaxReturnPage />);

    await screen.findByTestId('worksheet-card');
    expect(screen.queryByRole('button', { name: 'File return' })).not.toBeInTheDocument();
  });
});

describe('a filed return', () => {
  const filed = makeReturn({
    status: 'filed',
    filedAt: '2026-10-05T10:00:00.000Z',
    confirmationNumber: 'WA-0042',
    totalDue: 816.34,
    adjustments: [{ type: 'vendor_discount', amount: -8.04 }],
  });

  it('shows the filing, locks the adjustments and is at the payment', async () => {
    serve(filed);
    renderWithProviders(<SalesTaxReturnPage />);

    expect(await screen.findByTestId('confirmation-number')).toHaveTextContent('WA-0042');
    expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'current']);
    expect(screen.getByText(/locked once a return is filed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add adjustment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recalculate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete return' })).not.toBeInTheDocument();
  });

  it('opens the payment dialog with the total due', async () => {
    serve(filed);
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    expect(await screen.findByLabelText('Amount paid')).toHaveValue('816.34');
  });

  it('warns about documents that changed after filing and opens the exceptions', async () => {
    serve(filed, {
      ...noExceptions,
      items: [
        {
          key: 'credit_note|cn_1',
          document: { type: 'credit_note', id: 'cn_1', number: 'CM-0001', contactName: null, date: '2026-09-12' },
          taxDate: '2026-09-12',
          postedAt: '2026-10-06T09:00:00.000Z',
          taxLineIds: ['tl_1'],
          grossAmount: -100,
          taxableAmount: -100,
          taxAmount: -8,
          resolution: 'open',
          amendedByReturnId: null,
          countedByReturnId: null,
        },
      ],
      totals: { ...noExceptions.totals, open: { documents: 1, taxAmount: -8 } },
    });
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    const banner = await screen.findByTestId('exceptions-banner');
    expect(banner).toHaveTextContent('1 document in this period changed after filing.');
    await user.click(within(banner).getByRole('button', { name: 'Review' }));
    expect(await screen.findByTestId('exceptions-card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Carry forward all open' })).toBeInTheDocument();
  });

  it('has no exceptions tab before it is filed', async () => {
    renderWithProviders(<SalesTaxReturnPage />);
    await screen.findByTestId('worksheet-card');
    expect(screen.queryByRole('tab', { name: 'Exceptions' })).not.toBeInTheDocument();
  });

  it('links to the amendments of the return', async () => {
    serve({ ...filed, amendments: [{ id: 'txr_amend', status: 'calculated', filedAt: null }] });
    renderWithProviders(<SalesTaxReturnPage />);

    const card = await screen.findByTestId('amendments-card');
    expect(within(card).getByRole('link', { name: 'Amended return' })).toHaveAttribute('href', '/weldbooks/sales-tax/returns/txr_amend');
  });
});

describe('a paid return', () => {
  it('shows the payment and has nothing left to do', async () => {
    serve(
      makeReturn({
        status: 'paid',
        filedAt: '2026-10-05T10:00:00.000Z',
        confirmationNumber: 'WA-0042',
        paidAt: '2026-10-06T00:00:00.000Z',
        paymentAmount: 824.38,
        paymentJournalEntryId: 'je_77',
      }),
    );
    renderWithProviders(<SalesTaxReturnPage />);

    const filing = await screen.findByTestId('filing-card');
    expect(filing).toHaveTextContent('$824.38');
    expect(within(filing).getByRole('link', { name: 'View journal entry' })).toHaveAttribute('href', '/weldbooks/journal/je_77');
    expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });
});

describe('an amended return', () => {
  it('links back to the return it amends', async () => {
    serve(makeReturn({ amendsReturnId: 'txr_0' }));
    renderWithProviders(<SalesTaxReturnPage />);

    const badge = await screen.findByText('Amended return');
    expect(badge.closest('a')).toHaveAttribute('href', '/weldbooks/sales-tax/returns/txr_0');
  });
});

describe('when the return cannot be shown', () => {
  it('says the return does not exist (404)', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('Tax return not found'), { status: 404, code: 'NOT_FOUND', body: {} }));
    renderWithProviders(<SalesTaxReturnPage />);

    expect(await screen.findByText('Return not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All returns' })).toHaveAttribute('href', '/weldbooks/sales-tax/returns');
  });

  it('offers a retry for any other failure', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('Boom'), { status: 500, code: null, body: {} }));
    renderWithProviders(<SalesTaxReturnPage />);
    const user = userEvent.setup();

    expect(await screen.findByText('Could not load this page')).toBeInTheDocument();
    serve(makeReturn());
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('worksheet-card')).toBeInTheDocument();
  });
});
