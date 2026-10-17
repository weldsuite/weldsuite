import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const jurisdiction = vi.hoisted(() => ({ salesTax: true, resolved: true }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({
    features: { salesTax: jurisdiction.salesTax },
    isResolved: jurisdiction.resolved,
    isError: false,
  }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string | null | undefined, empty = '') => (value ? `date:${value}` : empty),
    formatMoney: (value: string) => `$${value}`,
    today: () => '2026-10-08',
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

import { SalesTaxAgencyPanel } from './sales-tax-agency-panel';
import {
  installPointerPolyfills,
  makeAgency,
  makeJurisdiction,
  makeRate,
  makeSettings,
  renderWithProviders,
} from '@/app/weldbooks/sales-tax/setup/test-support';

const setup = en.weldbooksUs.salesTax.setup;
const ta = setup.agency;

const agency = { ...makeAgency(), hasTaxLines: false };
const texas = makeJurisdiction({ id: 'stj_1', name: 'Texas', level: 'state', currentRate: 6.25 });
const travis = makeJurisdiction({
  id: 'stj_2',
  name: 'Travis County',
  level: 'county',
  code: '48453',
  currentRate: 0.5,
  rates: [makeRate({ id: 'r2', rate: '0.5000' })],
});
const austinZone = {
  id: 'stz_1',
  agencyId: 'sta_1',
  stateCode: 'TX',
  name: 'Austin',
  jurisdictionIds: ['stj_1', 'stj_2'],
  postalCodes: ['78701', '78702'],
  isOrigin: true,
  priority: 10,
  jurisdictions: [
    { id: 'stj_1', name: 'Texas', level: 'state', currentRate: 6.25 },
    { id: 'stj_2', name: 'Travis County', level: 'county', currentRate: 0.5 },
  ],
  combinedRate: 6.75,
};
const saasRule = {
  id: 'str_1',
  agencyId: 'sta_1',
  taxCode: 'saas',
  taxable: true,
  taxablePercent: '80.0000',
  appliesToUse: 'any',
  rateOverride: null,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  notes: 'Texas taxes SaaS on 80%',
};

function serve(
  overrides: { agency?: unknown; settings?: unknown; jurisdictions?: unknown[]; zones?: unknown[]; rules?: unknown[] } = {},
) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/sales-tax-agencies/')) {
      if ('agency' in overrides && overrides.agency === null) throw Object.assign(new Error('not found'), { status: 404 });
      return { data: overrides.agency ?? agency };
    }
    if (path.startsWith('/sales-tax/settings')) return { data: overrides.settings ?? makeSettings() };
    if (path.startsWith('/sales-tax-jurisdictions')) return { data: overrides.jurisdictions ?? [texas, travis] };
    if (path.startsWith('/sales-tax-zones')) return { data: overrides.zones ?? [] };
    if (path.startsWith('/sales-tax-rules')) return { data: overrides.rules ?? [] };
    return { data: [] };
  });
}

function renderPanel(onClose = vi.fn()) {
  renderWithProviders(<SalesTaxAgencyPanel id="sta_1" isOpen onClose={onClose} mode="fullscreen" onModeChange={vi.fn()} />);
  return onClose;
}

/** The list row (a `group` div of the tab list) that shows `text`. */
function rowWith(text: string): HTMLElement {
  const row = screen.getByText(text).closest<HTMLElement>('div.group');
  if (!row) throw new Error(`No list row shows ${text}`);
  return row;
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.delete.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  jurisdiction.salesTax = true;
  jurisdiction.resolved = true;
  permissions.allowed = new Set(['taxes:read', 'taxes:create', 'taxes:update', 'taxes:delete']);
  serve();
});

describe('SalesTaxAgencyPanel', () => {
  it('shows the registration, filing setup and ledger accounts of the agency', async () => {
    renderPanel();

    expect(await screen.findByText('Texas (TX)')).toBeInTheDocument();
    expect(screen.getAllByText('Registered').length).toBeGreaterThanOrEqual(1);
    // The agency's name in the registration (the state panel below repeats it).
    expect(screen.getAllByText('Texas Comptroller of Public Accounts').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('32-1234567')).toBeInTheDocument();
    // Registered from and the first period both start on 1 January.
    expect(screen.getAllByText('date:2026-01-01')).toHaveLength(2);
    expect(screen.getByText('Day 20 of the next month')).toBeInTheDocument();
    expect(screen.getByText('2201 Sales Tax Payable – Texas')).toBeInTheDocument();
    expect(screen.getByText('$1250.00')).toBeInTheDocument();
  });

  it('shows the jurisdictions tab with the rate in force today', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: ta.tabs.jurisdictions }));

    expect(await screen.findByText('Travis County')).toBeInTheDocument();
    expect(screen.getByText('6.25%')).toBeInTheDocument();
    expect(screen.getByText('0.5%')).toBeInTheDocument();
    expect(screen.getByText(/48453/)).toBeInTheDocument();
  });

  it('expands a jurisdiction to its rate history, with the rate in force marked', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: ta.tabs.jurisdictions }));
    await screen.findByText('Travis County');

    await user.click(within(rowWith('Travis County')).getByRole('button', { name: 'Travis County' }));

    expect(await screen.findByText('In force')).toBeInTheDocument();
    expect(screen.getByText(/No end date/)).toBeInTheDocument();
  });

  it('shows the server sentence when a jurisdiction is still in a zone and cannot be deleted', async () => {
    const user = userEvent.setup();
    api.delete.mockRejectedValue(new Error('This jurisdiction is part of the tax zone "Austin". Remove it from it first.'));
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: ta.tabs.jurisdictions }));
    await screen.findByText('Travis County');

    await user.click(within(rowWith('Travis County')).getByRole('button', { name: setup.jurisdictions.columns.actions }));
    await user.click(await screen.findByRole('menuitem', { name: setup.common.delete }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: setup.jurisdictions.deleteDialog.confirm }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This jurisdiction is part of the tax zone "Austin". Remove it from it first.'),
    );
  });

  it('invites the first jurisdiction when there are none', async () => {
    const user = userEvent.setup();
    serve({ jurisdictions: [] });
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: ta.tabs.jurisdictions }));

    expect(await screen.findByText(setup.jurisdictions.emptyTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: setup.jurisdictions.add })).toBeInTheDocument();
  });

  it('lists the zones with their ZIP codes, jurisdictions and combined rate', async () => {
    const user = userEvent.setup();
    serve({ zones: [austinZone] });
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: ta.tabs.zones }));

    const row = rowWith('Austin');
    expect(row).toHaveTextContent(setup.zones.origin);
    expect(row).toHaveTextContent('Texas, Travis County');
    expect(row).toHaveTextContent('78701, 78702');
    expect(row).toHaveTextContent('6.75%');
  });

  it('lists the taxability rules with their share, validity and notes', async () => {
    const user = userEvent.setup();
    serve({ rules: [saasRule] });
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: ta.tabs.rules }));

    const row = rowWith('Software as a service');
    expect(row).toHaveTextContent(setup.rules.taxable);
    expect(row).toHaveTextContent('80%');
    expect(row).toHaveTextContent('date:2026-01-01');
    expect(row).toHaveTextContent(setup.rules.noEnd);
    expect(row).toHaveTextContent('Texas taxes SaaS on 80%');
  });

  it('shows the audit log of the agency in the History tab', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: 'Audit Log' }));
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('sales_tax_agency:sta_1');
  });

  it('says plainly when the engine is not the manual one, and links to its settings', async () => {
    serve({ settings: makeSettings({ engine: 'stripe_tax', hasCredentials: true }) });
    renderPanel();

    expect(await screen.findByText('Your tax engine is Stripe Tax')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: ta.notManual.link })).toHaveAttribute('href', '/weldbooks/sales-tax/settings');
  });

  it('does not show that note while the engine is manual', async () => {
    renderPanel();
    await screen.findByText('Texas (TX)');
    await screen.findByText('2201 Sales Tax Payable – Texas');
    expect(screen.queryByText(/Your tax engine is/)).not.toBeInTheDocument();
  });

  it('says tax is not charged while the agency is not registered', async () => {
    serve({ agency: { ...agency, status: 'pending' } });
    renderPanel();
    expect(await screen.findByText('Tax is not charged for this agency while its status is Pending.')).toBeInTheDocument();
  });

  it('offers the registration edit and the status change to a member who may update', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByRole('button', { name: new RegExp(ta.changeStatus) })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: ta.editRegistration }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(ta.editTitle);
  });

  it('deletes an agency that was never used and closes the panel', async () => {
    const user = userEvent.setup();
    api.delete.mockResolvedValue(undefined);
    const onClose = renderPanel();

    await user.click(await screen.findByRole('button', { name: setup.jurisdictions.columns.actions }));
    await user.click(await screen.findByRole('menuitem', { name: ta.delete }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(ta.deleteDialog.description);
    await user.click(within(dialog).getByRole('button', { name: ta.deleteDialog.confirm }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/sales-tax-agencies/sta_1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(ta.deleted);
  });

  it('says so when the agency was closed instead of deleted, because tax was collected under it', async () => {
    const user = userEvent.setup();
    api.delete.mockResolvedValue({ data: { id: 'sta_1', deleted: false, closed: true, status: 'closed', registeredUntil: '2026-10-08' } });
    const onClose = renderPanel();

    await user.click(await screen.findByRole('button', { name: setup.jurisdictions.columns.actions }));
    await user.click(await screen.findByRole('menuitem', { name: ta.delete }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ta.deleteDialog.confirm }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(ta.closedInstead));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers only what the permissions allow', async () => {
    const user = userEvent.setup();
    permissions.allowed = new Set(['taxes:read']);
    renderPanel();

    await screen.findByText('Texas (TX)');
    await screen.findByText('2201 Sales Tax Payable – Texas');
    expect(screen.queryByRole('button', { name: ta.editRegistration })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(ta.changeStatus) })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: setup.jurisdictions.columns.actions }));
    expect(await screen.findByRole('menuitem', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: ta.delete })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('tab', { name: ta.tabs.jurisdictions }));
    await screen.findByText('Travis County');
    expect(screen.queryByRole('button', { name: setup.jurisdictions.add })).not.toBeInTheDocument();
  });

  it('says when the agency does not exist', async () => {
    serve({ agency: null });
    renderPanel();
    expect(await screen.findByText(ta.notFound)).toBeInTheDocument();
  });

  it('says so when the agency cannot be loaded, and offers to try again', async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValue(new Error('boom'));
    renderPanel();

    expect(await screen.findByText(ta.loadError)).toBeInTheDocument();
    serve();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Texas (TX)')).toBeInTheDocument();
  });

  it('shows nothing of the agency for an entity that is not a US one', async () => {
    jurisdiction.salesTax = false;
    renderPanel();
    expect(await screen.findByText(setup.common.usOnly)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shows nothing of the agency to a member who cannot read taxes', async () => {
    permissions.allowed = new Set();
    renderPanel();
    expect(await screen.findByText(setup.common.noAccess)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});
