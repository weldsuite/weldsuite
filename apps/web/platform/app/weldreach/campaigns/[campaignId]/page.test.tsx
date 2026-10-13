import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  campaignFixture,
  page,
  renderWithApp,
  stubRadixBrowserApis,
} from '@/app/weldreach/components/engage/test-utils';

const reach = vi.hoisted(() => ({
  getCampaign: vi.fn(),
  launch: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  listProspects: vi.fn(),
  listEnrollments: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ reach }) }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('@/lib/router', () => ({
  useParams: () => ({ campaignId: 'cmp_1' }),
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.granted.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ReachCampaignPage from './page';

beforeAll(stubRadixBrowserApis);

beforeEach(() => {
  for (const fn of Object.values(reach)) fn.mockReset();
  router.push.mockReset();
  router.replace.mockReset();
  permissions.granted = new Set(['reach_campaigns:read', 'reach_campaigns:update']);
  reach.listProspects.mockResolvedValue(page([]));
  reach.listEnrollments.mockResolvedValue(page([]));
  reach.preview.mockResolvedValue({ data: { subject: '', body: '', missingVariables: [] } });
});

describe('Campaign detail', () => {
  it('shows the name, status and the counts', async () => {
    reach.getCampaign.mockResolvedValue({ data: campaignFixture() });
    renderWithApp(<ReachCampaignPage />);

    expect(await screen.findByRole('heading', { name: 'Q4 outreach' })).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Prospects: 12 · Steps: 1 · Mailboxes: 1')).toBeInTheDocument();
  });

  it('launches after a confirmation', async () => {
    const user = userEvent.setup();
    reach.getCampaign.mockResolvedValue({ data: campaignFixture() });
    reach.launch.mockResolvedValue({ data: campaignFixture({ status: 'active' }) });
    renderWithApp(<ReachCampaignPage />);

    await user.click(await screen.findByRole('button', { name: 'Launch' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Launch this campaign?')).toBeInTheDocument();
    expect(reach.launch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Launch' }));

    await waitFor(() => expect(reach.launch).toHaveBeenCalledWith('cmp_1'));
    // The header switches to the running state.
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows the API reason when a launch is refused', async () => {
    const user = userEvent.setup();
    reach.getCampaign.mockResolvedValue({ data: campaignFixture() });
    reach.launch.mockRejectedValue(new Error('Connect an active mailbox before launching.'));
    renderWithApp(<ReachCampaignPage />);

    await user.click(await screen.findByRole('button', { name: 'Launch' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Launch' }));

    expect(await screen.findByText('Connect an active mailbox before launching.')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('pauses an active campaign', async () => {
    const user = userEvent.setup();
    reach.getCampaign.mockResolvedValue({ data: campaignFixture({ status: 'active' }) });
    reach.pause.mockResolvedValue({ data: campaignFixture({ status: 'paused' }) });
    renderWithApp(<ReachCampaignPage />);

    await user.click(await screen.findByRole('button', { name: 'Pause' }));

    await waitFor(() => expect(reach.pause).toHaveBeenCalledWith('cmp_1'));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('explains why a campaign paused itself', async () => {
    reach.getCampaign.mockResolvedValue({
      data: campaignFixture({ status: 'paused', pausedReason: 'bounce_rate' }),
    });
    renderWithApp(<ReachCampaignPage />);

    expect(await screen.findByText('This campaign was paused automatically')).toBeInTheDocument();
    expect(screen.getByText(/Too many emails bounced/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('does not show the reason for a pause the user chose', async () => {
    reach.getCampaign.mockResolvedValue({
      data: campaignFixture({ status: 'paused', pausedReason: 'manual' }),
    });
    renderWithApp(<ReachCampaignPage />);

    await screen.findByRole('button', { name: 'Resume' });
    expect(screen.queryByText('This campaign was paused automatically')).not.toBeInTheDocument();
  });

  it('offers no launch, pause or resume without the update permission', async () => {
    permissions.granted = new Set(['reach_campaigns:read']);
    reach.getCampaign.mockResolvedValue({ data: campaignFixture() });
    renderWithApp(<ReachCampaignPage />);

    await screen.findByRole('heading', { name: 'Q4 outreach' });
    expect(screen.queryByRole('button', { name: 'Launch' })).not.toBeInTheDocument();
  });

  it('shows an error and a way back when the campaign cannot be loaded', async () => {
    const user = userEvent.setup();
    reach.getCampaign.mockRejectedValue(new Error('Campaign not found.'));
    renderWithApp(<ReachCampaignPage />);

    expect(await screen.findByText('Campaign not found.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to campaigns' }));
    expect(router.push).toHaveBeenCalledWith('/weldreach/campaigns');
  });
});
