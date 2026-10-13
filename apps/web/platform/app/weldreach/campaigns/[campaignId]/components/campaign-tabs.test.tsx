import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReachEnrollment } from '@weldsuite/app-api-client/schemas/reach';
import {
  campaignFixture,
  page,
  renderWithApp,
  stubRadixBrowserApis,
} from '@/app/weldreach/components/engage/test-utils';

const reach = vi.hoisted(() => ({
  listMailboxes: vi.fn(),
  setMailboxes: vi.fn(),
  updateCampaign: vi.fn(),
  listEnrollments: vi.fn(),
  removeEnrollment: vi.fn(),
  addProspects: vi.fn(),
  listLists: vi.fn(),
  listProspects: vi.fn(),
  stepStats: vi.fn(),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ reach }) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMemberDirectory: () => ({
    data: { data: [{ userId: 'user_1', name: 'Sam Visser', email: 'sam@acme.test' }] },
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AddProspectsDialog } from './add-prospects-dialog';
import { MailboxesTab } from './mailboxes-tab';
import { ProspectsTab } from './prospects-tab';
import { SettingsTab } from './settings-tab';
import { StatsTab } from './stats-tab';

function mailbox(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    domainId: 'dom_1',
    domainName: 'outreach.example',
    email: `${id}@outreach.example`,
    firstName: 'Sam',
    lastName: 'Visser',
    signature: null,
    type: 'shared',
    status: 'active',
    warmupDay: 14,
    warmupStatus: 'maintaining',
    warmupInboxRate: 0.94,
    warmupSent7d: 70,
    warmupSpamRescues7d: 1,
    warmupBlocker: null,
    dailyCap: 30,
    rampCurrent: 30,
    sentToday: 4,
    lastSentAt: null,
    pausedReason: null,
    lastError: null,
    createdAt: '2026-09-01T09:00:00Z',
    ...overrides,
  };
}

function enrollment(id: string, overrides: Partial<ReachEnrollment> = {}): ReachEnrollment {
  return {
    id,
    campaignId: 'cmp_1',
    prospect: { id: `prs_${id}`, email: `${id}@acme.com`, firstName: 'Ana', lastName: id, companyName: 'Acme' },
    mailboxId: 'mbx_1',
    mailboxEmail: 'mbx_1@outreach.example',
    status: 'active',
    currentStep: 1,
    nextSendAt: '2026-10-13T09:00:00Z',
    stoppedReason: null,
    updatedAt: '2026-10-12T09:00:00Z',
    ...overrides,
  };
}

beforeAll(stubRadixBrowserApis);

beforeEach(() => {
  for (const fn of Object.values(reach)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  reach.listProspects.mockResolvedValue(page([]));
  reach.listEnrollments.mockResolvedValue(page([]));
  reach.listLists.mockResolvedValue(page([]));
});

describe('MailboxesTab', () => {
  beforeEach(() => {
    reach.listMailboxes.mockResolvedValue(
      page([
        mailbox('mbx_1'),
        mailbox('mbx_2', { status: 'warming', warmupDay: 5, warmupStatus: 'warming', warmupBlocker: 'too_early' }),
        mailbox('mbx_3', { status: 'deleted' }),
        mailbox('mbx_4', { status: 'paused', pausedReason: 'Bounce rate too high' }),
      ]),
    );
  });

  it('lists usable mailboxes with what each one can do, and hides deleted ones', async () => {
    renderWithApp(<MailboxesTab campaign={campaignFixture({ mailboxIds: ['mbx_1'] })} canEdit />);

    expect(await screen.findByText('mbx_1@outreach.example')).toBeInTheDocument();
    expect(screen.getByText(/Sent today: 4 of 30/)).toBeInTheDocument();
    expect(screen.getByText(/Starts after warmup \(day 5 of 14\)/)).toBeInTheDocument();
    expect(screen.getByText(/Bounce rate too high/)).toBeInTheDocument();
    expect(screen.queryByText('mbx_3@outreach.example')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /mbx_1@outreach.example/ })).toBeChecked();
  });

  it('saves the new selection', async () => {
    const user = userEvent.setup();
    reach.setMailboxes.mockResolvedValue({ data: campaignFixture({ mailboxIds: ['mbx_1', 'mbx_2'] }) });
    renderWithApp(<MailboxesTab campaign={campaignFixture({ mailboxIds: ['mbx_1'] })} canEdit />);

    await screen.findByText('mbx_2@outreach.example');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /mbx_2@outreach.example/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(reach.setMailboxes).toHaveBeenCalledWith('cmp_1', ['mbx_1', 'mbx_2']));
  });

  it('warns when none of the selected mailboxes can send yet', async () => {
    renderWithApp(<MailboxesTab campaign={campaignFixture({ mailboxIds: ['mbx_2'] })} canEdit />);

    expect(await screen.findByText('None of the selected mailboxes can send yet')).toBeInTheDocument();
  });

  it('is read-only without the permission to edit', async () => {
    renderWithApp(<MailboxesTab campaign={campaignFixture({ mailboxIds: ['mbx_1'] })} canEdit={false} />);

    expect(await screen.findByRole('checkbox', { name: /mbx_1@outreach.example/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('points to the mailboxes page when there are none', async () => {
    reach.listMailboxes.mockResolvedValue(page([]));
    renderWithApp(<MailboxesTab campaign={campaignFixture({ mailboxIds: [] })} canEdit />);

    const link = await screen.findByRole('link', { name: 'Go to mailboxes' });
    expect(link).toHaveAttribute('href', '/weldreach/mailboxes');
  });
});

describe('SettingsTab', () => {
  it('saves the schedule and limits together', async () => {
    const user = userEvent.setup();
    const campaign = campaignFixture();
    reach.updateCampaign.mockResolvedValue({ data: { ...campaign, dailyLimit: 150 } });
    renderWithApp(<SettingsTab campaign={campaign} canEdit />);

    const limit = screen.getByLabelText('Emails per day');
    expect(limit).toHaveValue(100);
    await user.clear(limit);
    await user.type(limit, '150');
    await user.click(screen.getByRole('button', { name: 'Fri' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(reach.updateCampaign).toHaveBeenCalledTimes(1));
    const [id, input] = reach.updateCampaign.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('cmp_1');
    expect(input).toMatchObject({
      name: 'Q4 outreach',
      ownerId: null,
      timezone: 'Europe/Amsterdam',
      sendDays: [1, 2, 3, 4],
      windowStart: '09:00',
      windowEnd: '17:00',
      dailyLimit: 150,
      minGapMinutes: 8,
      stopOnAutoReply: true,
    });
  });

  it('will not save a window that ends before it starts', async () => {
    const user = userEvent.setup();
    renderWithApp(<SettingsTab campaign={campaignFixture()} canEdit />);

    const end = screen.getByLabelText('Window ends');
    await user.clear(end);
    await user.type(end, '08:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('The window must end after it starts.')).toBeInTheDocument();
    expect(reach.updateCampaign).not.toHaveBeenCalled();
  });

  it('requires at least one send day', async () => {
    const user = userEvent.setup();
    renderWithApp(<SettingsTab campaign={campaignFixture({ sendDays: [1] })} canEdit />);

    await user.click(screen.getByRole('button', { name: 'Mon' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Pick at least one day.')).toBeInTheDocument();
    expect(reach.updateCampaign).not.toHaveBeenCalled();
  });

  it('is read-only without the permission to edit', () => {
    renderWithApp(<SettingsTab campaign={campaignFixture()} canEdit={false} />);

    expect(screen.getByLabelText('Campaign name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

describe('ProspectsTab', () => {
  beforeEach(() => {
    reach.listEnrollments.mockResolvedValue(
      page([
        enrollment('e1'),
        enrollment('e2', { status: 'replied', stoppedReason: 'reply', mailboxId: null, mailboxEmail: null, nextSendAt: null }),
      ]),
    );
  });

  it('shows each prospect with its status, mailbox, progress and why it stopped', async () => {
    renderWithApp(<ProspectsTab campaign={campaignFixture()} canEdit />);

    expect(await screen.findByText('Ana e1')).toBeInTheDocument();
    expect(screen.getByText('Replied')).toBeInTheDocument();
    expect(screen.getByText('They replied')).toBeInTheDocument();
    expect(screen.getByText('Chosen at the first send')).toBeInTheDocument();
    // One of one step has been sent for the first prospect.
    expect(screen.getAllByText('1 / 1').length).toBeGreaterThan(0);
  });

  it('filters by status on the server', async () => {
    const user = userEvent.setup();
    renderWithApp(<ProspectsTab campaign={campaignFixture()} canEdit />);
    await screen.findByText('Ana e1');

    const [filter] = screen.getAllByRole('combobox', { name: 'Filter by status' });
    await user.click(filter as HTMLElement);
    await user.click(await screen.findByRole('option', { name: 'Bounced' }));

    await waitFor(() =>
      expect(reach.listEnrollments.mock.calls.at(-1)).toEqual(['cmp_1', expect.objectContaining({ status: 'bounced' })]),
    );
  });

  it('removes a prospect from the campaign after confirmation', async () => {
    const user = userEvent.setup();
    reach.removeEnrollment.mockResolvedValue(undefined);
    renderWithApp(<ProspectsTab campaign={campaignFixture()} canEdit />);

    const row = (await screen.findByText('Ana e1')).closest('.group') as HTMLElement;
    await user.click(within(row).getAllByRole('button').at(-1) as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(reach.removeEnrollment).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(reach.removeEnrollment).toHaveBeenCalledWith('cmp_1', 'e1'));
  });
});

describe('AddProspectsDialog', () => {
  it('adds a list and reports what was left out', async () => {
    const user = userEvent.setup();
    reach.listLists.mockResolvedValue(
      page([{ id: 'lst_1', name: 'Logistics', description: null, source: 'csv', sourceRef: null, prospectCount: 40, createdAt: '2026-10-01T09:00:00Z' }]),
    );
    reach.addProspects.mockResolvedValue({
      data: {
        added: 35,
        skipped: [
          { reason: 'already_enrolled', count: 3 },
          { reason: 'suppressed', count: 2 },
        ],
      },
    });
    renderWithApp(<AddProspectsDialog campaignId="cmp_1" onClose={vi.fn()} />);

    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Logistics/ }));
    await user.click(screen.getByRole('button', { name: 'Add to campaign' }));

    await waitFor(() => expect(reach.addProspects).toHaveBeenCalledWith('cmp_1', { listId: 'lst_1' }));
    expect(await screen.findByText('Added to the campaign: 35')).toBeInTheDocument();
    expect(screen.getByText('Already in this campaign')).toBeInTheDocument();
    expect(screen.getByText('Opted out, bounced or blocked')).toBeInTheDocument();
  });

  it('adds hand-picked prospects', async () => {
    const user = userEvent.setup();
    reach.listProspects.mockResolvedValue(
      page([
        { id: 'prs_1', email: 'ana@acme.com', firstName: 'Ana', lastName: 'Jansen', companyName: 'Acme', companyDomain: 'acme.com', title: null, timezone: null, customFields: {}, source: 'csv', sourceRef: null, personId: null, validation: 'valid', createdAt: '2026-10-01T09:00:00Z' },
      ]),
    );
    reach.addProspects.mockResolvedValue({ data: { added: 1, skipped: [] } });
    renderWithApp(<AddProspectsDialog campaignId="cmp_1" onClose={vi.fn()} />);

    await user.click(screen.getByRole('tab', { name: 'Pick prospects' }));
    await user.click(await screen.findByText('Ana Jansen'));
    await user.click(screen.getByRole('button', { name: 'Add 1 selected' }));

    await waitFor(() => expect(reach.addProspects).toHaveBeenCalledWith('cmp_1', { prospectIds: ['prs_1'] }));
  });
});

describe('StatsTab', () => {
  it('shows the totals with rates and the per-step table', async () => {
    reach.stepStats.mockResolvedValue({
      data: [
        { stepId: 'stp_1', order: 0, sent: 40, replied: 3, bounced: 1 },
        { stepId: 'stp_2', order: 1, sent: 20, replied: 1, bounced: 0 },
      ],
    });
    renderWithApp(<StatsTab campaign={campaignFixture()} />);

    // 4 replies of 40 sent.
    expect(await screen.findAllByText('10% of emails sent')).not.toHaveLength(0);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Step 1')).toBeInTheDocument();
    expect(within(table).getByText('Step 2')).toBeInTheDocument();
    expect(within(table).getByText('7.5%')).toBeInTheDocument();
  });

  it('says so when nothing was sent yet', async () => {
    reach.stepStats.mockResolvedValue({ data: [] });
    renderWithApp(<StatsTab campaign={campaignFixture({ stats: { prospects: 3, sent: 0, replied: 0, interested: 0, bounced: 0, unsubscribed: 0 } })} />);

    expect(await screen.findByText('Nothing has been sent yet.')).toBeInTheDocument();
  });
});
