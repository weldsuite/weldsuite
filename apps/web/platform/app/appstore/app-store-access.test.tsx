import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { AppAccessView } from '@weldsuite/app-api-client/schemas/reach';
import type { AvailableApp } from '@/hooks/queries/use-settings-queries';

const install = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useBetaAppCodes: () => ({ data: new Set<string>() }),
  useInstallApp: () => ({ mutateAsync: install }),
  useUninstallApp: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/components/partner/use-app-licence', () => ({
  useAppLicence: () => ({ isUnlicensed: () => false, managed: null, askPartner: vi.fn() }),
}));
vi.mock('./custom-apps-section', () => ({ CustomAppsSection: () => null, OfficialHostedAppsSection: () => null }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./app-access-request-dialog', () => ({
  AppAccessRequestDialog: ({ app }: { app: { name: string } }) => <div>request form for {app.name}</div>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AppStoreClient } from './app-store-client';
import { AppAccessControls } from './app-access-controls';

function app(overrides: Partial<AvailableApp> = {}): AvailableApp {
  return {
    code: 'weldreach',
    name: 'WeldReach',
    description: 'Cold email outreach',
    icon: 'Send',
    category: 'Sales & Marketing',
    provider: 'WeldSuite',
    verified: true,
    isInstalled: false,
    requiresApproval: true,
    accessStatus: 'none',
    ...overrides,
  };
}

function wrap(ui: React.ReactElement) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

/** The buttons that would act on the app (the store also has category buttons). */
const ACTION = /Install|Uninstall|Request/;

beforeEach(() => install.mockReset());
afterEach(cleanup);

describe('app store tile for an app that is on request only', () => {
  async function hoverTile(user: ReturnType<typeof userEvent.setup>) {
    await user.hover(screen.getByRole('link', { name: /WeldReach/ }));
  }

  it('shows "On request" and offers Request access instead of Install', async () => {
    const user = userEvent.setup();
    wrap(<AppStoreClient initialApps={[app()]} categories={[]} canManage />);

    expect(screen.getByText('On request')).toBeInTheDocument();
    await hoverTile(user);
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
    // fireEvent: the revealed button sits inside the hovered tile, which user-event's pointer move would un-hover.
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(screen.getByText('request form for WeldReach')).toBeInTheDocument();
    expect(install).not.toHaveBeenCalled();
  });

  it('shows a pending request without any action', async () => {
    const user = userEvent.setup();
    wrap(<AppStoreClient initialApps={[app({ accessStatus: 'requested' })]} categories={[]} canManage />);

    expect(screen.getByText('Request pending')).toBeInTheDocument();
    await hoverTile(user);
    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
  });

  it('shows a suspension and does not offer a new request', async () => {
    const user = userEvent.setup();
    wrap(<AppStoreClient initialApps={[app({ accessStatus: 'suspended' })]} categories={[]} canManage />);

    expect(screen.getByText('Access suspended')).toBeInTheDocument();
    await hoverTile(user);
    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
  });

  it('offers a new request after a rejection', async () => {
    const user = userEvent.setup();
    wrap(<AppStoreClient initialApps={[app({ accessStatus: 'rejected' })]} categories={[]} canManage />);

    await hoverTile(user);
    expect(screen.getByRole('button', { name: 'Request again' })).toBeInTheDocument();
  });

  it('installs normally once approved', async () => {
    install.mockResolvedValue({});
    const user = userEvent.setup();
    wrap(<AppStoreClient initialApps={[app({ accessStatus: 'approved' })]} categories={[]} canManage />);

    expect(screen.queryByText('On request')).not.toBeInTheDocument();
    await hoverTile(user);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(install).toHaveBeenCalledWith({ appCode: 'weldreach' }));
  });

  it('keeps the plain Install button for apps without approval', async () => {
    const user = userEvent.setup();
    wrap(
      <AppStoreClient
        initialApps={[app({ code: 'weldcrm', name: 'WeldCRM', requiresApproval: false, accessStatus: undefined })]}
        categories={[]}
        canManage
      />,
    );

    await user.hover(screen.getByRole('link', { name: /WeldCRM/ }));
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
  });

  it('offers nothing to someone who cannot manage apps', async () => {
    const user = userEvent.setup();
    wrap(<AppStoreClient initialApps={[app()]} categories={[]} canManage={false} />);

    await hoverTile(user);
    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
  });
});

describe('AppAccessControls (app detail page)', () => {
  const view = (overrides: Partial<AppAccessView>): AppAccessView => ({
    appCode: 'weldreach',
    status: 'requested',
    request: null,
    limits: {},
    rejectionReason: null,
    suspendedReason: null,
    requestedAt: '2026-10-10T12:00:00.000Z',
    reviewedAt: null,
    ...overrides,
  });
  const base = { app: { code: 'weldreach', name: 'WeldReach' }, canManage: true };

  it('offers Request access to an admin who never asked', () => {
    wrap(<AppAccessControls {...base} status="none" />);
    expect(screen.getByRole('button', { name: 'Request access' })).toBeInTheDocument();
  });

  it('tells a non-admin that only owners and admins can request', () => {
    wrap(<AppAccessControls {...base} canManage={false} status="none" />);
    expect(screen.getByText('Only workspace owners and admins can request access.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
  });

  it('shows a pending request with its date and no button', () => {
    wrap(<AppAccessControls {...base} status="requested" view={view({})} />);
    expect(screen.getByText('Request pending')).toBeInTheDocument();
    expect(screen.getByText(/Requested on/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the rejection reason and offers to request again', () => {
    wrap(<AppAccessControls {...base} status="rejected" view={view({ status: 'rejected', rejectionReason: 'Lists look bought' })} />);
    expect(screen.getByText('Your request was not approved')).toBeInTheDocument();
    expect(screen.getByText(/Lists look bought/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request again' })).toBeInTheDocument();
  });

  it('shows the suspension reason and no way to request', () => {
    wrap(<AppAccessControls {...base} status="suspended" view={view({ status: 'suspended', suspendedReason: 'Too many complaints' })} />);
    expect(screen.getByText('WeldReach is suspended for this workspace')).toBeInTheDocument();
    expect(screen.getByText(/Too many complaints/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
