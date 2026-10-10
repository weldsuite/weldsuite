/**
 * The workspace detail page: role-gated actions, the licence save flow and the
 * credit grant with its Idempotency-Key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { ManagedWorkspaceDetail } from '@weldsuite/app-api-client/domains/partners';
import type { PartnerContractView } from '@weldsuite/app-api-client/schemas/partners';
import PartnerWorkspaceDetailPage from './detail-page';

const contract: PartnerContractView = {
  id: 'ptc_1',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  currency: 'USD',
  revenueShareBps: 7500,
  baseMinimum: '50.00',
  includedCredits: 2000,
  creditFloorPrice: '0.004',
  extraCreditPrice: '0.01',
  allowedFeaturePlanIds: [],
  paymentTermsDays: 30,
  pastDueAfterDays: 14,
  readOnlyAfterDays: 30,
};

const workspace: ManagedWorkspaceDetail = {
  workspaceId: 'ws_1',
  name: 'Acme Industries',
  slug: 'acme',
  provisioningStatus: 'ready',
  ownerEmail: 'owner@acme.example',
  licence: {
    status: 'active',
    packageId: null,
    allowedApps: ['welddesk'],
    monthlyCredits: 2000,
    creditRolloverCap: 0,
    maxSeats: null,
    featurePlanId: null,
    storageGb: null,
    resalePricing: { model: 'flat', amount: '400.00' },
    startsAt: '2026-03-01T00:00:00.000Z',
    endsAt: null,
  },
  packageName: null,
  activeMembers: 3,
  creditsUsedThisPeriod: 500,
  creditBalance: 1500,
  estimate: { resale: 40000, share: 30000, baseFloor: 5000, creditFloor: 0, floor: 5000, due: 30000, margin: 10000, basis: 'share' },
  createdAt: '2026-03-01T00:00:00.000Z',
  history: [
    {
      id: 'wlc_1',
      snapshot: {
        status: 'active',
        packageId: null,
        allowedApps: ['welddesk'],
        monthlyCredits: 2000,
        creditRolloverCap: 0,
        maxSeats: null,
        featurePlanId: null,
        storageGb: null,
        resalePricing: { model: 'flat', amount: '400.00' },
      },
      changedBy: 'user_1',
      changedByType: 'partner',
      reason: 'Initial licence',
      changedAt: '2026-03-01T10:00:00.000Z',
    },
  ],
};

const mocks = vi.hoisted(() => ({
  can: (_perm: string): boolean => true,
  setLicence: vi.fn(),
  setStatus: vi.fn(),
  grant: vi.fn(),
}));

vi.mock('@/lib/partner/partner-context', () => ({
  usePartnerContext: () => ({ can: (perm: string) => mocks.can(perm), partnerId: 'ptr_1' }),
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({ workspaceId: 'ws_1' }),
}));
vi.mock('@/hooks/queries/use-partner-queries', () => ({
  usePartnerWorkspace: () => ({ data: workspace, isLoading: false, error: null, refetch: vi.fn() }),
  usePartnerOverview: () => ({ data: { contract } }),
  usePartnerCatalog: () => ({
    data: {
      apps: [
        { code: 'welddesk', name: 'WeldDesk', icon: 'x' },
        { code: 'weldcrm', name: 'WeldCRM', icon: 'x' },
      ],
      featurePlans: [],
    },
  }),
  usePartnerPackages: () => ({ data: [] }),
  useSetWorkspaceLicence: () => ({ mutateAsync: mocks.setLicence, isPending: false }),
  useSetLicenceStatus: () => ({ mutateAsync: mocks.setStatus, isPending: false }),
  useGrantCredits: () => ({ mutateAsync: mocks.grant, isPending: false }),
}));

function renderPage() {
  return render(
    <I18nProvider initialLanguage="en">
      <PartnerWorkspaceDetailPage />
    </I18nProvider>,
  );
}

describe('PartnerWorkspaceDetailPage', () => {
  beforeEach(() => {
    mocks.can = () => true;
    mocks.setLicence.mockReset();
    mocks.setStatus.mockReset();
    mocks.grant.mockReset();
  });

  it('shows usage, the live preview and the history', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Acme Industries' })).toBeInTheDocument();
    expect(screen.getByTestId('preview-due').textContent).toBe('$300.00');
    expect(screen.getByTestId('preview-margin').textContent).toBe('$100.00');
    expect(screen.getByText('“Initial licence”')).toBeInTheDocument();
  });

  it('hides every action from a role that cannot manage licences', () => {
    mocks.can = (perm) => perm === 'partner:workspaces:read';
    renderPage();
    expect(screen.queryByRole('button', { name: /grant extra credits/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End licence' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save licence' })).toBeNull();
    expect(screen.getByLabelText('Monthly credits')).toBeDisabled();
  });

  it('updates the preview as the price is edited and saves the licence', async () => {
    mocks.setLicence.mockResolvedValue({ data: workspace });
    renderPage();

    const save = screen.getByRole('button', { name: 'Save licence' });
    expect(save).toBeDisabled(); // nothing changed yet

    const amount = screen.getByLabelText('Amount (USD)');
    await userEvent.clear(amount);
    await userEvent.type(amount, '60');

    // $60 flat: 75% = $45 < $50 minimum, so WeldSuite bills the minimum.
    expect(screen.getByTestId('preview-due').textContent).toBe('$50.00');
    expect(screen.getByTestId('preview-margin').textContent).toBe('$10.00');

    await userEvent.click(save);
    await waitFor(() => expect(mocks.setLicence).toHaveBeenCalledTimes(1));
    expect(mocks.setLicence.mock.calls[0]![0]).toMatchObject({
      allowedApps: ['welddesk'],
      monthlyCredits: 2000,
      resalePricing: { model: 'flat', amount: '60' },
    });
  });

  it('refuses an invalid price without calling the server', async () => {
    renderPage();
    const amount = screen.getByLabelText('Amount (USD)');
    await userEvent.clear(amount);
    await userEvent.type(amount, 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save licence' }));
    expect(await screen.findByText(/enter an amount such as/i)).toBeInTheDocument();
    expect(mocks.setLicence).not.toHaveBeenCalled();
  });

  it('asks before suspending, then sends the new status', async () => {
    mocks.setStatus.mockResolvedValue({ data: workspace });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Suspend this workspace?')).toBeInTheDocument();
    expect(mocks.setStatus).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(mocks.setStatus).toHaveBeenCalledWith({ status: 'suspended' }));
  });

  it('grants extra credits with an Idempotency-Key and shows what it adds to the statement', async () => {
    mocks.grant.mockResolvedValue({ data: { newBalance: 2500, amount: 1000, charge: '10.00' } });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /grant extra credits/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Credits'), '1000');
    // 1,000 credits at $0.01 each
    expect(within(dialog).getByText('Added to your statement: $10.00')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Grant credits' }));
    await waitFor(() => expect(mocks.grant).toHaveBeenCalledTimes(1));
    const vars = mocks.grant.mock.calls[0]![0] as { body: { credits: number }; idempotencyKey: string };
    expect(vars.body).toEqual({ credits: 1000 });
    expect(vars.idempotencyKey).toMatch(/\S{8,}/);
  });
});
