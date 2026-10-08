import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const auth = vi.hoisted(() => ({ userId: 'user_a' as string | null }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: auth.userId }) }));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'prn_1' }),
  useNavigate: () => router.navigate,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/weldbooks/payment-runs/prn_1' } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: 'US', isError: false }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', async () => {
  const { testFormat } = await import('../test-utils');
  return { useWeldbooksFormat: () => testFormat };
});
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMemberDirectory: () => ({
    data: {
      data: [
        { userId: 'user_maker', name: 'Maya Maker' },
        { userId: 'user_a', name: 'Alex Approver' },
        { userId: 'user_b', name: 'Bo Second' },
      ],
    },
  }),
}));
const files = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@/lib/weldbooks/download', () => ({ downloadBlob: files.download }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import PaymentRunDetailPage from './page';
import { installPointerPolyfills, renderWithProviders } from '../test-utils';

const at = '2026-10-08T10:00:00.000Z';

function makeRun(overrides: Partial<PaymentRunDetail> = {}): PaymentRunDetail {
  return {
    id: 'prn_1',
    bankAccountId: 'bnk_1',
    bankAccountName: 'Operating',
    method: 'ach',
    status: 'pending_approval',
    paymentDate: '2026-10-09',
    secCode: null,
    sameDay: false,
    totalAmount: '350.50',
    paymentCount: 1,
    requiredApprovals: 2,
    approvalCount: 1,
    billCount: 2,
    heldVendorCount: 1,
    fileName: null,
    fileGeneratedAt: null,
    createdBy: 'user_maker',
    createdAt: at,
    updatedAt: at,
    notes: null,
    bankAccount: { id: 'bnk_1', name: 'Operating', accountNumberLast4: '1234' },
    heldAmount: '80.00',
    withheldAmount: '0.00',
    netAmount: '350.50',
    approvals: [{ userId: 'user_maker', at }],
    items: [
      { billId: 'b1', billNumber: 'INV-1', partyId: 'par_acme', partyName: 'Acme Supplies', amount: '350.50', billTotal: '350.50', balanceDue: '350.50', dueDate: '2026-10-01T00:00:00.000Z' },
    ],
    vendors: [
      { partyId: 'par_acme', name: 'Acme Supplies', amount: '350.50', billCount: 1, held: false, backupWithholding: null, holds: [], payment: null },
      {
        partyId: 'par_bright',
        name: 'Brightline LLC',
        amount: '80.00',
        billCount: 1,
        held: true,
        backupWithholding: null,
        holds: [{ code: 'bank_details_changed', message: 'changed', releasable: false, released: null, blocker: 'verify' }],
        payment: null,
      },
    ],
    holds: [
      { partyId: 'par_bright', partyName: 'Brightline LLC', code: 'bank_details_changed', message: 'changed', released: null, releasable: false },
      { partyId: 'par_acme', partyName: 'Acme Supplies', code: 'in_other_run', message: 'In another run', released: null, releasable: true },
    ],
    history: [
      { action: 'created', userId: 'user_maker', at, changes: null },
      { action: 'approved', userId: 'user_maker', at, changes: { approvals: { old: 0, new: 1 } } },
    ],
    ...overrides,
  };
}

function load(run: PaymentRunDetail) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/payment-runs/prn_1') return { data: run };
    if (path.startsWith('/payment-runs/settings/')) return { data: { achSettings: { sameDayAllowed: false } } };
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  router.navigate.mockReset();
  router.navigate.mockResolvedValue(undefined);
  files.download.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  auth.userId = 'user_a';
  permissions.allowed = new Set(['banking:read', 'banking:create', 'banking:manage', 'bills:read']);
});

describe('PaymentRunDetailPage', () => {
  it('shows the run with its approvals, holds, vendors and history by name', async () => {
    load(makeRun());
    renderWithProviders(<PaymentRunDetailPage />);

    expect(await screen.findByText('Vendors on hold: 2')).toBeInTheDocument();
    expect(screen.getByText('Made by Maya Maker')).toBeInTheDocument();
    expect(screen.getByText('Approval 1: Maya Maker')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval 2')).toBeInTheDocument();
    expect(screen.getAllByText('Bank details changed').length).toBeGreaterThan(0);
    expect(screen.getByText('Run created')).toBeInTheDocument();
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
  });

  it('approves as the second approver', async () => {
    load(makeRun());
    api.post.mockResolvedValue({ data: { run: makeRun({ status: 'approved' }), approved: true, approvalCount: 2, requiredApprovals: 2, payments: [] } });
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-runs/prn_1/approve'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Approved. The payments were made.'));
  });

  it('does not let the person who approved approve again', async () => {
    auth.userId = 'user_maker';
    load(makeRun());
    renderWithProviders(<PaymentRunDetailPage />);

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByText(/already approved this run/)).toBeInTheDocument();
  });

  it('finishes an interrupted approval', async () => {
    load(makeRun({ approvalCount: 2, approvals: [{ userId: 'user_maker', at }, { userId: 'user_b', at }] }));
    api.post.mockResolvedValue({ data: { run: makeRun({ status: 'approved' }), approved: true, approvalCount: 2, requiredApprovals: 2, payments: [] } });
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Finish approval' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-runs/prn_1/approve'));
  });

  it('rejects with a reason', async () => {
    load(makeRun());
    api.post.mockResolvedValue({ data: makeRun({ status: 'draft', approvals: [] }) });
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('Say why, in a few words. It is kept with the record.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText('Reason'), 'Wrong bank account');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-runs/prn_1/reject', { reason: 'Wrong bank account' }));
  });

  it('releases a hold that can be released, with a reason, and sends bank detail holds to the vendor', async () => {
    load(makeRun());
    api.post.mockResolvedValue({ data: makeRun() });
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunDetailPage />);

    await screen.findByText('Holds');
    // Only the hold on bills in another run can be released; the bank detail hold points at the vendor.
    expect(screen.getAllByRole('button', { name: 'Release hold' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Fix on the vendor' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Release hold' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Pay in full, W-9 pending');
    await user.click(within(dialog).getByRole('button', { name: 'Release hold' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/payment-runs/prn_1/release-hold', { partyId: 'par_acme', reason: 'Pay in full, W-9 pending' }),
    );
  });

  it('cannot release holds without permission to manage banking', async () => {
    permissions.allowed = new Set(['banking:read', 'banking:create', 'bills:read']);
    load(makeRun());
    renderWithProviders(<PaymentRunDetailPage />);

    await screen.findByText('Holds');
    expect(screen.queryByRole('button', { name: 'Release hold' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('downloads the NACHA file of an approved ACH run and keeps only its summary on screen', async () => {
    load(makeRun({ status: 'approved', approvalCount: 2, holds: [], heldVendorCount: 0, heldAmount: '0.00' }));
    api.get.mockImplementation(async (path: string) => {
      if (path === '/payment-runs/prn_1') return { data: makeRun({ status: 'approved', holds: [], heldVendorCount: 0, heldAmount: '0.00' }) };
      if (path === '/payment-runs/prn_1/nacha') {
        return {
          data: {
            fileName: 'ach-2026-10-09-prn_1.ach',
            content: '101 ...',
            summary: {
              runId: 'prn_1',
              fileName: 'ach-2026-10-09-prn_1.ach',
              fileDate: '2026-10-08',
              effectiveEntryDate: '2026-10-09',
              fileIdModifier: 'A',
              sameDay: false,
              balanced: false,
              paymentCount: 1,
              prenoteCount: 0,
              batchCount: 1,
              recordCount: 6,
              blockCount: 1,
              entryHash: '0',
              totalCredit: '350.50',
              totalDebit: '0.00',
              originator: { companyName: 'ACME' },
              payments: [
                { paymentId: 'pay_1', partyId: 'par_acme', name: 'Acme Supplies', amount: '280.50', grossAmount: '350.50', backupWithholdingAmount: '70.00', secCode: 'CCD', accountLast4: '6789', traceNumber: '1' },
              ],
              prenotes: [],
              warnings: [{ code: 'x', message: 'Check the effective date' }],
            },
          },
        };
      }
      return { data: [] };
    });
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Download NACHA file' }));
    await waitFor(() => expect(files.download).toHaveBeenCalledTimes(1));
    expect(files.download.mock.calls[0]?.[1]).toBe('ach-2026-10-09-prn_1.ach');
    expect(await screen.findByText('$350.50', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Backup withholding kept back')).toBeInTheDocument();
    expect(screen.getByText('$70.00', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Check the effective date')).toBeInTheDocument();
    expect(screen.queryByText('101 ...')).not.toBeInTheDocument();
  });

  it('lists what is missing when the ACH settings are incomplete', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/payment-runs/prn_1') return { data: makeRun({ status: 'approved', holds: [], heldVendorCount: 0, heldAmount: '0.00' }) };
      if (path === '/payment-runs/prn_1/nacha') {
        throw Object.assign(new Error('incomplete'), {
          status: 409,
          code: 'ACH_SETTINGS_INCOMPLETE',
          body: { error: { code: 'ACH_SETTINGS_INCOMPLETE', details: { missing: ['companyIdentification'] } } },
        });
      }
      return { data: [] };
    });
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Download NACHA file' }));
    expect(await screen.findByText('The company identification (1 and your EIN)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open payment settings' })).toBeInTheDocument();
  });

  it('marks an exported run completed only after confirming the bank has the file', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/payment-runs/prn_1') {
        return { data: makeRun({ status: 'exported', fileName: 'ach.ach', fileGeneratedAt: at, holds: [], heldVendorCount: 0, heldAmount: '0.00' }) };
      }
      return { data: [] };
    });
    api.post.mockResolvedValue({ data: makeRun({ status: 'completed' }) });
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Mark as completed' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Only do this once your bank has accepted the file.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Mark as completed' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-runs/prn_1/complete'));
  });

  it('offers to print the checks of an approved check run', async () => {
    load(
      makeRun({
        method: 'check',
        status: 'approved',
        holds: [],
        heldVendorCount: 0,
        heldAmount: '0.00',
        vendors: [
          {
            partyId: 'par_acme',
            name: 'Acme Supplies',
            amount: '350.50',
            billCount: 1,
            held: false,
            backupWithholding: null,
            holds: [],
            payment: {
              id: 'pay_1',
              amount: '350.50',
              backupWithholdingAmount: null,
              netAmount: '350.50',
              checkNumber: '001001',
              checkStatus: 'to_print',
              deleted: false,
            },
          },
        ],
      }),
    );
    renderWithProviders(<PaymentRunDetailPage />);

    expect(await screen.findByText('Checks waiting to be printed: 1.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Print checks' })).toHaveAttribute('href', '/weldbooks/payment-runs/$id/checks');
    expect(screen.getByText('Check 001001')).toBeInTheDocument();
  });

  it('submits a draft, and deletes it only after confirming', async () => {
    load(makeRun({ status: 'draft', approvals: [], approvalCount: 0 }));
    api.post.mockResolvedValue({ data: makeRun({ status: 'pending_approval' }) });
    api.delete.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-runs/prn_1/submit'));

    await user.click(screen.getByRole('button', { name: 'Delete draft' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.delete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/payment-runs/prn_1'));
    await waitFor(() => expect(router.navigate).toHaveBeenCalledWith({ to: '/weldbooks/payment-runs' }));
  });

  it('shows what backup withholding takes from a vendor, as figures and not as a hold', async () => {
    load(
      makeRun({
        holds: [],
        heldVendorCount: 0,
        heldAmount: '0.00',
        totalAmount: '5000.00',
        withheldAmount: '1200.00',
        netAmount: '3800.00',
        vendors: [
          {
            partyId: 'par_echo',
            name: 'Echo Freelance',
            amount: '5000.00',
            billCount: 1,
            held: false,
            backupWithholding: { amount: '1200.00', net: '3800.00', reason: 'no_tin', rate: 0.24 },
            holds: [],
            payment: null,
          },
        ],
      }),
    );
    renderWithProviders(<PaymentRunDetailPage />);

    expect(await screen.findByText('Bills settled')).toBeInTheDocument();
    expect(screen.getByText('$5000.00', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('-$1200.00')).toBeInTheDocument();
    expect(screen.getByText('Paid to vendors')).toBeInTheDocument();
    expect(screen.getByText('$3800.00', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Backup withholding 24%: $1200.00 withheld, vendor paid $3800.00')).toBeInTheDocument();
    expect(screen.queryByText('Holds')).not.toBeInTheDocument();
    expect(screen.queryByText(/Vendors on hold/)).not.toBeInTheDocument();
  });

  it('shows the net a vendor was paid once the payment exists', async () => {
    load(
      makeRun({
        status: 'approved',
        method: 'check',
        holds: [],
        heldVendorCount: 0,
        heldAmount: '0.00',
        totalAmount: '3000.00',
        withheldAmount: '720.00',
        netAmount: '2280.00',
        vendors: [
          {
            partyId: 'par_oscar',
            name: 'Oscar Consulting',
            amount: '3000.00',
            billCount: 1,
            held: false,
            backupWithholding: { amount: '720.00', net: '2280.00', reason: null, rate: 0.24 },
            holds: [],
            payment: {
              id: 'pay_o',
              amount: '3000.00',
              backupWithholdingAmount: '720.00',
              netAmount: '2280.00',
              checkNumber: '001002',
              checkStatus: 'to_print',
              deleted: false,
            },
          },
        ],
      }),
    );
    renderWithProviders(<PaymentRunDetailPage />);
    expect(await screen.findByText('Backup withholding 24%: $720.00 withheld, vendor paid $2280.00')).toBeInTheDocument();
    expect(screen.getByText('Check 001002')).toBeInTheDocument();
  });

  it('does not offer to release a hold that exists because the chart has no withholding account', async () => {
    load(
      makeRun({
        holds: [
          { partyId: 'par_echo', partyName: 'Echo Freelance', code: 'backup_withholding', message: 'no account', released: null, releasable: false },
        ],
        heldVendorCount: 1,
      }),
    );
    renderWithProviders(<PaymentRunDetailPage />);

    await screen.findByText('Holds');
    expect(screen.getByText('No withholding account')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release hold' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the chart of accounts' })).toHaveAttribute('href', '/weldbooks/accounts');
  });

  it('says so when the run does not exist', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('not found'), { status: 404, code: 'NOT_FOUND', body: {} }));
    renderWithProviders(<PaymentRunDetailPage />);
    expect(await screen.findByText('This payment run was not found. It may have been deleted.')).toBeInTheDocument();
  });
});
