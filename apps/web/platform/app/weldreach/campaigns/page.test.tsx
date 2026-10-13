import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReachCampaign } from '@weldsuite/app-api-client/schemas/reach';
import {
  campaignFixture,
  page,
  renderWithApp,
  stubRadixBrowserApis,
} from '@/app/weldreach/components/engage/test-utils';

const reach = vi.hoisted(() => ({
  listCampaigns: vi.fn(),
  createCampaign: vi.fn(),
  deleteCampaign: vi.fn(),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ reach }) }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('@/lib/router', () => ({ useRouter: () => router }));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.granted.has(permission) }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import ReachCampaignsPage from './page';

function campaign(id: string, overrides: Partial<ReachCampaign> = {}): ReachCampaign {
  const { steps: _steps, mailboxIds: _mailboxIds, ...rest } = campaignFixture({ id, name: `Campaign ${id}` });
  return { ...rest, ...overrides };
}

function lastParams() {
  return reach.listCampaigns.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeAll(stubRadixBrowserApis);

beforeEach(() => {
  for (const fn of Object.values(reach)) fn.mockReset();
  router.push.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.granted = new Set([
    'reach_campaigns:read',
    'reach_campaigns:create',
    'reach_campaigns:delete',
  ]);
  reach.listCampaigns.mockResolvedValue(
    page([
      campaign('a', { name: 'Q4 outreach', status: 'active' }),
      campaign('b', { name: 'Events follow-up', status: 'draft' }),
    ]),
  );
});

describe('Campaigns list', () => {
  it('shows each campaign with its status and numbers', async () => {
    renderWithApp(<ReachCampaignsPage />);

    expect(await screen.findByText('Q4 outreach')).toBeInTheDocument();
    expect(screen.getByText('Events follow-up')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('opens a campaign when its row is clicked', async () => {
    const user = userEvent.setup();
    renderWithApp(<ReachCampaignsPage />);

    const row = (await screen.findByText('Q4 outreach')).closest('.group') as HTMLElement;
    await user.click(within(row).getAllByRole('button')[0] as HTMLElement);

    expect(router.push).toHaveBeenCalledWith('/weldreach/campaigns/a');
  });

  it('filters by status on the server', async () => {
    const user = userEvent.setup();
    renderWithApp(<ReachCampaignsPage />);
    await screen.findByText('Q4 outreach');

    const [filter] = screen.getAllByRole('combobox', { name: 'Filter by status' });
    await user.click(filter as HTMLElement);
    await user.click(await screen.findByRole('option', { name: 'Paused' }));

    await waitFor(() => expect(lastParams()).toMatchObject({ status: 'paused' }));
  });

  it('creates a campaign from its name and opens it', async () => {
    const user = userEvent.setup();
    reach.createCampaign.mockResolvedValue({ data: campaignFixture({ id: 'new_1', name: 'Fresh' }) });
    renderWithApp(<ReachCampaignsPage />);

    await user.click(await screen.findByRole('button', { name: 'New campaign' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create campaign' }));
    expect(await within(dialog).findByText('Enter a name for the campaign.')).toBeInTheDocument();
    expect(reach.createCampaign).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText('Name'), '  Fresh  ');
    await user.click(within(dialog).getByRole('button', { name: 'Create campaign' }));

    await waitFor(() => expect(reach.createCampaign).toHaveBeenCalledWith({ name: 'Fresh' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/weldreach/campaigns/new_1'));
  });

  it('deletes a campaign only after confirmation', async () => {
    const user = userEvent.setup();
    reach.deleteCampaign.mockResolvedValue(undefined);
    renderWithApp(<ReachCampaignsPage />);

    const row = (await screen.findByText('Events follow-up')).closest('.group') as HTMLElement;
    await user.click(within(row).getAllByRole('button').at(-1) as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete campaign?')).toBeInTheDocument();
    expect(reach.deleteCampaign).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(reach.deleteCampaign).toHaveBeenCalledWith('b'));
  });

  it('says why a delete failed', async () => {
    const user = userEvent.setup();
    reach.deleteCampaign.mockRejectedValue(new Error('Pause the campaign before deleting it.'));
    renderWithApp(<ReachCampaignsPage />);

    const row = (await screen.findByText('Q4 outreach')).closest('.group') as HTMLElement;
    await user.click(within(row).getAllByRole('button').at(-1) as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Pause the campaign before deleting it.'));
  });

  it('leaves out create and delete without the permissions', async () => {
    permissions.granted = new Set(['reach_campaigns:read']);
    renderWithApp(<ReachCampaignsPage />);
    await screen.findByText('Q4 outreach');

    expect(screen.queryByRole('button', { name: 'New campaign' })).not.toBeInTheDocument();
    const row = screen.getByText('Q4 outreach').closest('.group') as HTMLElement;
    // Only the stretched row button is left: there is no options menu.
    expect(within(row).getAllByRole('button')).toHaveLength(1);
  });

  it('invites the first campaign when there are none', async () => {
    reach.listCampaigns.mockResolvedValue(page([]));
    renderWithApp(<ReachCampaignsPage />);

    expect(await screen.findByText('No campaigns yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create your first campaign' })).toBeInTheDocument();
  });
});
