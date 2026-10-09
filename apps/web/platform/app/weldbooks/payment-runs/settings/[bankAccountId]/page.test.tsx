import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ bankAccountId: 'bnk_1' }),
  useNavigate: () => router.navigate,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/weldbooks/payment-runs/settings/bnk_1' } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: 'US', isError: false }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', async () => {
  const { testFormat } = await import('../../test-utils');
  return { useWeldbooksFormat: () => testFormat };
});
const files = vi.hoisted(() => ({ download: vi.fn(), print: vi.fn() }));
vi.mock('@/lib/weldbooks/download', () => ({ downloadBlob: files.download }));
vi.mock('@/lib/weldbooks/print-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/weldbooks/print-pdf')>()),
  printPdfBytes: files.print,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import PaymentSettingsPage from './page';
import { installPointerPolyfills, renderWithProviders } from '../../test-utils';

const settings = {
  bankAccountId: 'bnk_1',
  bankAccountName: 'Operating',
  bankName: 'First Bank',
  routingNumber: '021000021',
  accountNumberLast4: '6789',
  hasAccountNumber: true,
  nextCheckNumber: 1001,
  highestCheckNumberUsed: 1000,
  checkSettings: {
    layout: 'voucher_top',
    alignment: {},
    printMicr: false,
    micrLayout: 'business',
    checkNumberWidth: 6,
    bankName: null,
    bankAddressLines: [],
    fractionalNumerator: null,
    signatureLineText: null,
  },
  achSettings: {
    immediateDestination: null,
    immediateDestinationName: null,
    immediateOrigin: null,
    immediateOriginName: null,
    companyName: null,
    companyIdentification: null,
    odfiRoutingNumber: null,
    balanced: false,
    offsetBankAccountId: null,
    defaultSecCode: 'CCD',
    sameDayAllowed: false,
    entryDescription: null,
    holdWindowDays: 10,
    requirePrenotes: false,
  },
  effectiveAch: {
    immediateDestination: '021000021',
    immediateDestinationName: 'First Bank',
    immediateOrigin: null,
    immediateOriginName: 'Acme Holdings LLC',
    companyName: 'Acme Holdings LLC',
    companyIdentification: null,
    odfiRoutingNumber: '021000021',
  },
  positivePayFormat: 'generic_csv',
  readiness: {
    checks: { ready: true, missing: [] },
    ach: { ready: false, missing: ['companyIdentification', 'immediateOrigin'] },
    positivePay: { ready: true, missing: [] },
  },
  layouts: [
    { id: 'voucher_top', label: 'Check on top, two stubs', description: 'One check per Letter page with the check at the top and two voucher stubs below.' },
    { id: 'three_per_page', label: 'Three checks per page', description: 'Three checks per Letter page, without stubs.' },
  ],
  positivePayFormats: [
    { id: 'generic_csv', label: 'Generic CSV', kind: 'csv', documentation: 'generic', needsBankSpec: false, note: 'Account number, check number and amount.' },
    { id: 'chase', label: 'Chase (ACCESS)', kind: 'csv', documentation: 'none', needsBankSpec: true, note: 'Template.' },
  ],
};

const operating = { id: 'bnk_1', name: 'Operating', isActive: true, accountType: 'checking', accountNumberLast4: '6789', bankName: 'First Bank' };

function routes() {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/payment-runs/settings/bnk_1') return { data: settings };
    if (path.startsWith('/bank-accounts')) return { data: [operating] };
    return { data: [] };
  });
  api.put.mockResolvedValue({ data: settings });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(files)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:create', 'banking:manage']);
  routes();
});

describe('PaymentSettingsPage', () => {
  it('shows what is ready and what each way of paying still misses', async () => {
    renderWithProviders(<PaymentSettingsPage />);

    expect(await screen.findByText('What is ready')).toBeInTheDocument();
    expect(screen.getByText('Not complete')).toBeInTheDocument();
    expect(screen.getByText('The company identification (1 and your EIN)')).toBeInTheDocument();
    expect(screen.getByText('The immediate origin (your company id or routing number)')).toBeInTheDocument();
    expect(screen.getAllByText('Ready')).toHaveLength(2);
  });

  it('explains the MICR font gap as soon as blank check stock is turned on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentSettingsPage />);
    await screen.findByText('What is ready');

    expect(screen.queryByText('The MICR line is not printed yet')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Bank name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Print on blank check stock' }));
    expect(await screen.findByText('The MICR line is not printed yet')).toBeInTheDocument();
    expect(screen.getByText(/needs a MICR \(E-13B\) font/)).toBeInTheDocument();
    expect(screen.getByLabelText('Bank name')).toBeInTheDocument();
  });

  it('saves only what changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentSettingsPage />);
    const next = await screen.findByLabelText('Next check number');

    await user.clear(next);
    await user.type(next, '1500');
    await user.click(screen.getByRole('switch', { name: 'Require prenotes' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/payment-runs/settings/bnk_1', {
        nextCheckNumber: 1500,
        achSettings: { requirePrenotes: true },
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Payment settings saved.'));
  });

  it('sends the EIN only when one is typed and never shows the stored one', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentSettingsPage />);
    const ein = await screen.findByLabelText('EIN');
    expect(ein).toHaveValue('');

    await user.type(ein, '12-3456789');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/payment-runs/settings/bnk_1', { achSettings: { ein: '12-3456789' } }));
  });

  it('refuses a routing number that fails the ABA check and sends nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentSettingsPage />);
    await user.type(await screen.findByLabelText('Immediate destination', { selector: '#ach-destination' }), '021000022');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('This routing number does not pass the ABA check.')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('says nothing changed instead of calling the server', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentSettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Nothing changed.'));
    expect(api.put).not.toHaveBeenCalled();
  });

  it('downloads an alignment test page for the layout in the form', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentSettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Download test page' }));

    await waitFor(() => expect(files.download).toHaveBeenCalledTimes(1));
    expect(files.download.mock.calls[0]?.[1]).toBe('check-alignment-test.pdf');
  });

  it('is read-only without permission to manage banking', async () => {
    permissions.allowed = new Set(['banking:read']);
    renderWithProviders(<PaymentSettingsPage />);

    expect(await screen.findByText(/Changing them takes permission to manage banking/)).toBeInTheDocument();
    expect(screen.getByLabelText('Next check number')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows the error when the settings cannot be loaded', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/payment-runs/settings/bnk_1') {
        throw Object.assign(new Error('Bank account with ID bnk_1 not found'), { status: 404, code: 'NOT_FOUND', body: {} });
      }
      return { data: [operating] };
    });
    renderWithProviders(<PaymentSettingsPage />);
    expect(await screen.findByText('This could not be found. It may have been deleted.')).toBeInTheDocument();
  });
});
