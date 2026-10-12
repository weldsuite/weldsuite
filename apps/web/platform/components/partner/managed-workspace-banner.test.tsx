import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { ManagedBillingInfo } from '@weldsuite/app-api-client/schemas/partners';
import { ManagedWorkspaceBanner } from './managed-workspace-banner';
import { ManagedBillingView } from './managed-billing-view';

const mocks = vi.hoisted(() => ({ managed: null as unknown }));

vi.mock('@/hooks/queries/use-partner-queries', () => ({
  useManagedBilling: () => ({ data: mocks.managed }),
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ orgId: 'org_1' }),
}));

function info(patch: Partial<ManagedBillingInfo> = {}): ManagedBillingInfo {
  return {
    partner: {
      id: 'ptr_1',
      name: 'Acme Partner',
      logoUrl: null,
      websiteUrl: 'https://partner.example',
      supportEmail: 'help@partner.example',
      supportUrl: null,
    },
    partnerStatus: 'active',
    licence: { status: 'active', allowedApps: ['welddesk', 'weldcrm'], monthlyCredits: 3000, maxSeats: 10 },
    creditsUsedThisPeriod: 750,
    creditBalance: 2250,
    activeMembers: 4,
    readOnly: false,
    ...patch,
  };
}

const wrap = (ui: React.ReactElement) => render(<I18nProvider initialLanguage="en">{ui}</I18nProvider>);

describe('ManagedWorkspaceBanner', () => {
  beforeEach(() => {
    mocks.managed = null;
    window.sessionStorage.clear();
  });

  it('shows nothing for a workspace that is billed directly', () => {
    wrap(<ManagedWorkspaceBanner />);
    expect(screen.queryByTestId('managed-workspace-banner')).toBeNull();
  });

  it('shows nothing while the partner is in good standing', () => {
    mocks.managed = info();
    wrap(<ManagedWorkspaceBanner />);
    expect(screen.queryByTestId('managed-workspace-banner')).toBeNull();
  });

  it('says the workspace is read-only and who to contact, and cannot be dismissed', () => {
    mocks.managed = info({ readOnly: true, partnerStatus: 'suspended' });
    wrap(<ManagedWorkspaceBanner />);
    const banner = screen.getByTestId('managed-workspace-banner');
    expect(banner).toHaveTextContent('This workspace is read-only');
    expect(banner).toHaveTextContent('Contact Acme Partner');
    expect(screen.getByRole('link', { name: 'Contact Acme Partner' })).toHaveAttribute(
      'href',
      'mailto:help@partner.example',
    );
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });

  it('warns about a past-due partner and can be dismissed for the session', async () => {
    mocks.managed = info({ partnerStatus: 'past_due' });
    const { unmount } = wrap(<ManagedWorkspaceBanner />);
    expect(screen.getByTestId('managed-workspace-banner')).toHaveTextContent('Action needed by Acme Partner');

    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('managed-workspace-banner')).toBeNull();

    unmount();
    wrap(<ManagedWorkspaceBanner />);
    expect(screen.queryByTestId('managed-workspace-banner')).toBeNull();
  });

  it('prefers read-only over past-due', () => {
    mocks.managed = info({ readOnly: true, partnerStatus: 'past_due' });
    wrap(<ManagedWorkspaceBanner />);
    expect(screen.getByTestId('managed-workspace-banner')).toHaveTextContent('This workspace is read-only');
  });
});

describe('ManagedBillingView', () => {
  it('replaces plans and invoices with the partner and the licence', () => {
    wrap(<ManagedBillingView info={info()} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your subscription is managed by Acme Partner');
    expect(screen.getByRole('link', { name: 'help@partner.example' })).toBeInTheDocument();
    expect(screen.getByText('750 used of 3,000 · 2,250 credits left')).toBeInTheDocument();
    expect(screen.getByText('4 of 10 in use')).toBeInTheDocument();
    // No way to buy anything from WeldSuite.
    expect(screen.queryByRole('button', { name: /upgrade|checkout|buy/i })).toBeNull();
  });

  it('shows unlimited seats and an empty app list plainly', () => {
    wrap(
      <ManagedBillingView
        info={info({ licence: { status: 'active', allowedApps: [], monthlyCredits: 0, maxSeats: null } })}
      />,
    );
    expect(screen.getByText('4 in use')).toBeInTheDocument();
    expect(screen.getByText('Only the core features are included.')).toBeInTheDocument();
  });

  it('tells a read-only workspace to contact the partner', () => {
    wrap(<ManagedBillingView info={info({ readOnly: true })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Contact Acme Partner to restore full access.');
  });
});
