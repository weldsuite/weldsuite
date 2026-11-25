import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnnualReport } from '@/lib/weldbooks/annual-report-model';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
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
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatDate: (value: string | null | undefined) => (value ? `date:${value.slice(0, 10)}` : '') }),
}));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => true }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import AnnualReportsPage from './page';
import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

function report(extra: Partial<AnnualReport> = {}): AnnualReport {
  return {
    id: 'ar_1',
    fiscalYear: 2025,
    sizeClass: 'small',
    status: 'draft',
    filedAt: null,
    filingReference: null,
    digipoortResponse: null,
    ...extra,
  } as AnnualReport;
}

function serve(rows: AnnualReport[]) {
  api.get.mockImplementation(async (path: string) => (path === '/annual-reports' ? { data: rows } : { data: null }));
}

function row(name: string) {
  return screen.getByRole('button', { name }).closest('div.group') as HTMLElement;
}

async function openDialog() {
  const user = userEvent.setup();
  renderWithProviders(<AnnualReportsPage />);
  await user.click(await screen.findByRole('button', { name: 'New annual report' }));
  return { user, dialog: await screen.findByRole('dialog', { name: 'New annual report' }) };
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(toast), navigate]) fn.mockReset();
  permissions.allowed = new Set(['reports:read', 'reports:create']);
  serve([report()]);
});

describe('annual reports list', () => {
  it('lists the reports with their size, status and filing, and opens one by its row', async () => {
    serve([
      report({
        status: 'filed',
        filedAt: '2026-06-01T10:00:00.000Z',
        filingReference: 'KVK-123',
        digipoortResponse: { environment: 'preprod' },
      } as Partial<AnnualReport>),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<AnnualReportsPage />);
    await screen.findByRole('button', { name: 'Annual report 2025' });
    const line = row('Annual report 2025');
    expect(line).toHaveTextContent('Small');
    expect(line).toHaveTextContent('Filed');
    expect(line).toHaveTextContent('date:2026-06-01');
    expect(line).toHaveTextContent('KVK-123');
    expect(within(line).getByTestId('preprod-badge')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Annual report 2025' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/annual-reports/$id', params: { id: 'ar_1' } });
  });

  it('creates a report for the first free year and opens it', async () => {
    api.post.mockResolvedValue({ data: report({ id: 'ar_2', fiscalYear: 2026, sizeClass: 'micro' }) });
    const { user, dialog } = await openDialog();
    // 2025 already has a report, so the dialog proposes 2026.
    expect(within(dialog).getByRole('combobox', { name: 'Financial year' })).toHaveTextContent('2026');
    expect(within(dialog).getByRole('radio', { name: /^Small/ })).toBeChecked();

    await user.click(within(dialog).getByRole('radio', { name: /^Micro/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(api.post).toHaveBeenCalledWith('/annual-reports', { fiscalYear: 2026, sizeClass: 'micro' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/annual-reports/$id', params: { id: 'ar_2' } }));
    expect(toast.success).toHaveBeenCalledWith('Annual report created');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens the report that already exists for the year', async () => {
    api.post.mockRejectedValue(
      Object.assign(new Error('An annual report for this year exists'), { status: 409, body: { error: { details: { id: 'ar_9' } } } }),
    );
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/annual-reports/$id', params: { id: 'ar_9' } }));
    expect(toast.info).toHaveBeenCalledWith('An annual report for 2026 already exists. Opening it.');
  });

  it('says why creating failed and keeps the dialog open', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('The ledger has no Dutch chart'), { status: 422, body: {} }));
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not create the annual report', { description: 'The ledger has no Dutch chart' }),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New annual report' })).toBeInTheDocument();
  });

  it('closes the dialog on cancel', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows the empty state, without a create button for someone who may only read', async () => {
    serve([]);
    permissions.allowed = new Set(['reports:read']);
    renderWithProviders(<AnnualReportsPage />);
    expect(await screen.findByText('No annual reports yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New annual report' })).not.toBeInTheDocument();
  });

  it('says when the list could not be loaded', async () => {
    api.get.mockRejectedValue(new Error('offline'));
    renderWithProviders(<AnnualReportsPage />);
    expect(await screen.findByText('Could not load the annual reports')).toBeInTheDocument();
  });
});
