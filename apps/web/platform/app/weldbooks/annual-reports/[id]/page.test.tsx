import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnnualReport } from '@/lib/weldbooks/annual-report-model';
import { emptyLines } from '@/lib/weldbooks/annual-report-model';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), getBlob: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ features: { vatReturn: true }, isResolved: true, isError: false, jurisdiction: { name: 'Netherlands' } }),
}));
vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ entityId: 'ent_1' }) }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return {
    ...(await importOriginal<typeof import('@tanstack/react-router')>()),
    Link: RouteLink,
    useNavigate: () => navigate,
    useParams: () => ({ id: 'ar_1' }),
  };
});
const today = vi.hoisted(() => () => '2026-11-22');
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `€${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => (value ? `date:${value.slice(0, 10)}` : ''),
    formatDateTime: (value: string) => `datetime:${value.slice(0, 10)}`,
    today,
  }),
}));
const edition = vi.hoisted(() => ({ kvk: true }));
vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: (feature: string) => (feature === 'kvk-digipoort' ? edition.kvk : true),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import AnnualReportPage from './page';
import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

function report(extra: Partial<AnnualReport> = {}): AnnualReport {
  return {
    id: 'ar_1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    entityId: 'ent_1',
    fiscalYear: 2025,
    periodStart: '2025-01-01T00:00:00.000Z',
    periodEnd: '2025-12-31T00:00:00.000Z',
    sizeClass: 'small',
    status: 'draft',
    figures: {
      current: { ...emptyLines(), cash: 100, shareCapital: 60, currentLiabilities: 40 },
      prior: null,
      accounts: [{ item: 'cash', accountId: 'acc_1', code: '1100', name: 'Bank', current: 100, prior: null }],
      computedAt: '2026-11-01T00:00:00.000Z',
      edited: false,
    },
    disclosures: {
      legalForm: 'bv',
      kvkNumber: '12345678',
      registeredOffice: 'Utrecht',
      city: 'Utrecht',
      postalCode: '3511AB',
      email: 'a@b.nl',
      preparedOn: '2026-11-01',
      appropriation: 'after',
      averageEmployees: 3,
    },
    adopted: false,
    adoptionDate: null,
    filingReference: null,
    digipoortResponse: null,
    filedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    notes: null,
    issues: [],
    ...extra,
  } as AnnualReport;
}

function serve(row: AnnualReport) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/annual-reports/ar_1') return { data: row };
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  navigate.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  edition.kvk = true;
  permissions.allowed = new Set(['reports:read', 'reports:create', 'reports:update', 'reports:delete']);
  serve(report());
  api.patch.mockResolvedValue({ data: report() });
  api.post.mockResolvedValue({ data: {} });
});

describe('annual report page', () => {
  it('shows the balance sheet with totals, and the accounts behind a line', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AnnualReportPage />);
    expect(await screen.findByText('Annual report 2025')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: /Cash and bank, 2025/ })).toBeDefined();
    const assets = screen.getByText('Total assets').closest('tr') as HTMLElement;
    expect(assets).toHaveTextContent('€100.00');
    expect(screen.getByText('The balance sheet balances.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show 1 accounts of Cash and bank' }));
    expect(screen.getByText('1100 Bank')).toBeInTheDocument();
  });

  it('warns when the balance sheet does not balance', async () => {
    serve(report({ figures: { ...report().figures, current: { ...emptyLines(), cash: 100 } } }));
    renderWithProviders(<AnnualReportPage />);
    expect(await screen.findByText(/doesn't balance: assets differ from equity and liabilities by €100.00/)).toBeInTheDocument();
  });

  it('lists what blocks filing, disables filing, and shows an issue under its field', async () => {
    serve(report({ issues: [{ field: 'kvkNumber', message: 'KvK number is required' }] }));
    renderWithProviders(<AnnualReportPage />);
    const banner = await screen.findByTestId('readiness-issues');
    expect(within(banner).getByText('KvK number is required')).toBeInTheDocument();
    expect(screen.getAllByText('KvK number is required')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'File with the KvK' })).toBeDisabled();
  });

  it('says it is ready when nothing is missing', async () => {
    renderWithProviders(<AnnualReportPage />);
    expect(await screen.findByTestId('readiness-ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'File with the KvK' })).toBeEnabled();
  });

  it('sends only the changed figure when saving', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AnnualReportPage />);
    const receivables = await screen.findByRole('spinbutton', { name: 'Receivables, 2025' });
    await user.type(receivables, '25.5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [path, body] = api.patch.mock.calls[0];
    expect(path).toBe('/annual-reports/ar_1');
    expect(body.figures).toEqual({ current: { receivables: 25.5 } });
    expect(body.disclosures.kvkNumber).toBe('12345678');
    expect(toast.success).toHaveBeenCalledWith('Annual report saved');
  });

  it('files with the KvK only after a confirmation that says it is public', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { id: 'ar_1', status: 'submitted', kenmerk: 'K1', environment: 'production', message: 'ok' } });
    renderWithProviders(<AnnualReportPage />);
    await user.click(await screen.findByRole('button', { name: 'File with the KvK' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/becomes public in the commercial register/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'File with the KvK' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/annual-reports/ar_1/file'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Annual report sent to the KvK through Digipoort'));
  });

  it('shows why Digipoort refused the filing', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new Error('Digipoort refused: certificate expired'));
    renderWithProviders(<AnnualReportPage />);
    await user.click(await screen.findByRole('button', { name: 'File with the KvK' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'File with the KvK' }));
    expect(await screen.findByText('Digipoort refused: certificate expired')).toBeInTheDocument();
  });

  it('has no Digipoort filing without the kvk-digipoort feature, but can mark it as filed', async () => {
    edition.kvk = false;
    const user = userEvent.setup();
    renderWithProviders(<AnnualReportPage />);
    await screen.findByText('Annual report 2025');
    expect(screen.queryByRole('button', { name: 'File with the KvK' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mark as filed' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Filing reference (optional)'), 'KVK-9');
    await user.click(within(dialog).getByRole('button', { name: 'Mark as filed' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/annual-reports/ar_1/mark-filed', { filingReference: 'KVK-9', filedAt: '2026-11-22' }),
    );
  });

  it('locks a submitted report and checks its status, listing what Digipoort reported', async () => {
    const user = userEvent.setup();
    serve(report({ status: 'submitted', filingReference: 'K1', digipoortResponse: { environment: 'preprod' } }));
    api.get.mockImplementation(async (path: string) => {
      if (path === '/annual-reports/ar_1') return { data: report({ status: 'submitted', filingReference: 'K1', digipoortResponse: { environment: 'preprod' } }) };
      if (path === '/annual-reports/ar_1/filing-status')
        return {
          data: {
            id: 'ar_1',
            success: true,
            status: 'processing',
            statuses: [{ code: '100', at: '2026-11-22T10:00:00Z', description: 'Received by the KvK' }],
          },
        };
      return { data: [] };
    });
    renderWithProviders(<AnnualReportPage />);
    expect(await screen.findByText(/sent to the KvK through Digipoort/)).toBeInTheDocument();
    expect(screen.getByTestId('preprod-badge')).toHaveTextContent('Test environment (pre-production)');
    expect(screen.getByRole('spinbutton', { name: 'Receivables, 2025' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'File with the KvK' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Received by the KvK')).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith('Filing status: Being processed');
  });

  it('shows the reason a rejected report was refused, and keeps it editable', async () => {
    serve(report({ status: 'rejected', rejectionReason: 'Balance sheet total is missing' }));
    renderWithProviders(<AnnualReportPage />);
    expect(await screen.findByTestId('rejection-notice')).toHaveTextContent('Balance sheet total is missing');
    expect(screen.getByRole('spinbutton', { name: 'Receivables, 2025' })).toBeEnabled();
  });

  it('deletes a draft after a confirmation and returns to the list', async () => {
    const user = userEvent.setup();
    api.delete.mockResolvedValue(undefined);
    renderWithProviders(<AnnualReportPage />);
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/annual-reports/ar_1'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/annual-reports' }));
  });

  it('offers no delete or save without the permissions', async () => {
    permissions.allowed = new Set(['reports:read']);
    const user = userEvent.setup();
    renderWithProviders(<AnnualReportPage />);
    await screen.findByText('Annual report 2025');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Download XBRL' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('says so when the report does not exist', async () => {
    api.get.mockResolvedValue({ data: null });
    renderWithProviders(<AnnualReportPage />);
    expect(await screen.findByText('Annual report not found.')).toBeInTheDocument();
  });
});
