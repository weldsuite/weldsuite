import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VatReturn } from '@/lib/api/domains/weldbooks';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const jurisdiction = vi.hoisted(() => ({ vatReturn: true }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ features: { vatReturn: jurisdiction.vatReturn }, isResolved: true, isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `€${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => (value ? `date:${value}` : ''),
    formatDateTime: (value: string) => `datetime:${value.slice(0, 10)}`,
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit-panel">{`${entityType}:${entityId}`}</div>
  ),
}));

import { VatReturnPanel } from './vat-return-panel';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

function vatReturn(extra: Partial<VatReturn> = {}): VatReturn {
  return {
    id: 'vr_1',
    periodType: 'quarterly',
    periodStart: '2026-01-01',
    periodEnd: '2026-03-31',
    periodLabel: 'Q1 2026',
    status: 'calculated',
    rubrieken: { r1a: 10000, r1aBtw: 2100, r5a: 2100, r5b: 600, r5g: 1500 },
    suppletieDeadline: null,
    filingReference: null,
    filedAt: null,
    filedBy: null,
    notes: null,
    ...extra,
  };
}

function serve(vr: VatReturn | null) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/vat-returns/vr_1') {
      if (vr === null) return { data: null };
      return { data: vr };
    }
    if (path === '/vat-returns/vr_1/xml') return '<xml/>';
    return { data: [] };
  });
}

function renderPanel(onClose = vi.fn()) {
  renderWithProviders(<VatReturnPanel id="vr_1" isOpen onClose={onClose} mode="fullscreen" onModeChange={vi.fn()} />);
  return onClose;
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset().mockResolvedValue({ data: {} });
  api.delete.mockReset().mockResolvedValue(undefined);
  panelOpen.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  jurisdiction.vatReturn = true;
  permissions.allowed = new Set(['reports:read', 'reports:create', 'reports:update', 'reports:delete']);
  serve(vatReturn());
});

describe('VatReturnPanel', () => {
  it('shows the period and status in the header and the headline totals in the Details tab', async () => {
    renderPanel();
    expect(await screen.findByText('VAT return Q1 2026')).toBeInTheDocument();
    expect(screen.getAllByText('Calculated').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('VAT due (5a)').parentElement?.nextElementSibling).toHaveTextContent('€2100.00');
    expect(screen.getByText('Input VAT (5b)').parentElement?.nextElementSibling).toHaveTextContent('€600.00');
    expect(screen.getByText('Total (5g)').parentElement?.nextElementSibling).toHaveTextContent('€1500.00');
    expect(screen.getByText('date:2026-01-01 — date:2026-03-31')).toBeInTheDocument();
    expect(screen.getByText('Quarterly')).toBeInTheDocument();
  });

  it('shows the filing details, the correction deadline and the notes of a filed return', async () => {
    serve(
      vatReturn({
        status: 'filed',
        filingReference: 'KEN-123',
        filedAt: '2026-04-02T10:00:00.000Z',
        filedBy: 'Jan',
        suppletieDeadline: '2026-06-30',
        notes: 'Filed on the last day',
      }),
    );
    renderPanel();
    expect(await screen.findByText('KEN-123')).toBeInTheDocument();
    expect(screen.getByText('datetime:2026-04-02')).toBeInTheDocument();
    expect(screen.getByText('Jan')).toBeInTheDocument();
    expect(screen.getByText('date:2026-06-30')).toBeInTheDocument();
    expect(screen.getByText('Filed on the last day')).toBeInTheDocument();
  });

  it('lists the boxes of the aangifte with their turnover, VAT and the totals', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: 'Return boxes' }));

    const boxRow = screen.getByText('1a. Supplies and services taxed at the standard rate').parentElement as HTMLElement;
    expect(boxRow).toHaveTextContent('€10000.00€2100.00');
    const total = screen.getByText('5g. Total to pay / to reclaim').parentElement as HTMLElement;
    expect(total).toHaveTextContent('€1500.00');
  });

  it('shows the audit log of the VAT return in the History tab', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: 'Audit Log' }));
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('vat_return:vr_1');
  });

  it('files a calculated return and says so', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'File with the Dutch Tax Administration' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/vat-returns/vr_1/file'));
    expect(await screen.findByText('VAT return filed')).toBeInTheDocument();
  });

  it('shows why filing failed', async () => {
    api.post.mockRejectedValue(new Error('Digipoort is down'));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'File with the Dutch Tax Administration' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Filing failed: Digipoort is down');
  });

  it('offers no filing for a return that is already filed, but offers the follow-up', async () => {
    const user = userEvent.setup();
    serve(vatReturn({ status: 'filed' }));
    renderPanel();
    await screen.findByText('VAT return Q1 2026');
    expect(screen.queryByRole('button', { name: 'File with the Dutch Tax Administration' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(await screen.findByRole('menuitem', { name: 'Check status' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Check for corrections' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('opens the correction on top when the ledger changed after filing', async () => {
    const user = userEvent.setup();
    serve(vatReturn({ status: 'filed' }));
    api.post.mockResolvedValue({ data: { correctionRequired: true, id: 'vr_2', netDiff: 50, message: 'A correction is needed' } });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Check for corrections' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/vat-returns/vr_1/suppletie'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('A correction is needed'));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'vat_return', id: 'vr_2', mode: 'fullscreen', stack: true });
  });

  it('shows the filing status of a filed return', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation(async (path: string) => {
      if (path === '/vat-returns/vr_1') return { data: vatReturn({ status: 'filed' }) };
      if (path === '/vat-returns/vr_1/filing-status') return { data: { id: 'vr_1', kenmerk: 'K', status: 'accepted' } };
      return { data: [] };
    });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Check status' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Filing status: accepted'));
  });

  it('deletes a return that was not filed, after a confirmation, and closes the panel', async () => {
    const user = userEvent.setup();
    const onClose = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.delete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/vat-returns/vr_1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('VAT return deleted');
  });

  it('keeps the panel open and says why when the delete fails', async () => {
    api.delete.mockRejectedValue(new Error('Already filed'));
    const user = userEvent.setup();
    const onClose = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not delete the VAT return', { description: 'Already filed' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers only what the permissions allow', async () => {
    const user = userEvent.setup();
    permissions.allowed = new Set(['reports:read']);
    renderPanel();
    await screen.findByText('VAT return Q1 2026');
    expect(screen.queryByRole('button', { name: 'File with the Dutch Tax Administration' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(await screen.findByRole('menuitem', { name: 'Download XML' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('says so when the jurisdiction has no VAT return', async () => {
    jurisdiction.vatReturn = false;
    renderPanel();
    expect(await screen.findByText('No VAT return for this entity')).toBeInTheDocument();
  });

  it('says so when the return does not exist', async () => {
    serve(null);
    renderPanel();
    expect(await screen.findByText('VAT return not found.')).toBeInTheDocument();
  });
});
