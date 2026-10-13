import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReachProspect } from '@weldsuite/app-api-client/schemas/reach';
import {
  page,
  renderWithApp,
  stubRadixBrowserApis,
} from '@/app/weldreach/components/engage/test-utils';

const reach = vi.hoisted(() => ({
  listProspects: vi.fn(),
  listLists: vi.fn(),
  addListMembers: vi.fn(),
  deleteProspect: vi.fn(),
  createList: vi.fn(),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ reach }) }));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.granted.has(permission) }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import ReachProspectsPage from './page';

function prospect(id: string, overrides: Partial<ReachProspect> = {}): ReachProspect {
  return {
    id,
    email: `${id}@acme.com`,
    firstName: null,
    lastName: null,
    companyName: null,
    companyDomain: 'acme.com',
    title: null,
    timezone: null,
    customFields: {},
    source: 'csv',
    sourceRef: null,
    personId: null,
    validation: 'valid',
    createdAt: '2026-10-01T09:00:00Z',
    ...overrides,
  };
}

const ana = prospect('prs_ana', {
  email: 'ana@acme.com',
  firstName: 'Ana',
  lastName: 'Jansen',
  companyName: 'Acme',
  title: 'CTO',
});
const info = prospect('prs_info', { email: 'info@widgets.nl', validation: 'role' });
const gmail = prospect('prs_gmail', { email: 'bo@gmail.com', validation: 'consumer' });

const lists = [
  { id: 'lst_1', name: 'Logistics', description: null, source: 'csv', sourceRef: null, prospectCount: 2, createdAt: '2026-10-01T09:00:00Z' },
  { id: 'lst_2', name: 'Events', description: null, source: 'csv', sourceRef: null, prospectCount: 1, createdAt: '2026-10-02T09:00:00Z' },
];

function lastProspectParams() {
  return reach.listProspects.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeAll(stubRadixBrowserApis);

beforeEach(() => {
  for (const fn of Object.values(reach)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.granted = new Set([
    'reach_prospects:read',
    'reach_prospects:create',
    'reach_prospects:update',
    'reach_prospects:delete',
  ]);
  reach.listProspects.mockResolvedValue(page([ana, info, gmail]));
  reach.listLists.mockResolvedValue(page(lists));
});

describe('Prospects page', () => {
  it('lists prospects with their company and what validation found', async () => {
    renderWithApp(<ReachProspectsPage />);

    expect(await screen.findByText('Ana Jansen')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('CTO')).toBeInTheDocument();
    expect(screen.getByText('Role address')).toBeInTheDocument();
    expect(screen.getByText('Consumer')).toBeInTheDocument();
    expect(screen.getByText('3 in total')).toBeInTheDocument();
  });

  it('shows the lists with their counts and filters the table to one', async () => {
    const user = userEvent.setup();
    renderWithApp(<ReachProspectsPage />);

    const panel = await screen.findByRole('complementary', { name: 'Lists' });
    expect(await within(panel).findByText('Logistics')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: /^Logistics/ }));

    await waitFor(() => expect(lastProspectParams()).toMatchObject({ listId: 'lst_1' }));
    await user.click(within(panel).getByRole('button', { name: 'All prospects' }));
    await waitFor(() => expect(lastProspectParams().listId).toBeUndefined());
  });

  it('filters by validation on the server', async () => {
    const user = userEvent.setup();
    renderWithApp(<ReachProspectsPage />);
    await screen.findByText('Ana Jansen');

    const [filter] = screen.getAllByRole('combobox', { name: 'Filter by validation' });
    await user.click(filter as HTMLElement);
    await user.click(await screen.findByRole('option', { name: 'Role address' }));

    await waitFor(() => expect(lastProspectParams()).toMatchObject({ validation: 'role' }));
  });

  it('searches on the server once typing pauses', async () => {
    const user = userEvent.setup();
    renderWithApp(<ReachProspectsPage />);
    await screen.findByText('Ana Jansen');

    await user.type(screen.getAllByPlaceholderText('Search prospects')[0] as HTMLElement, 'acme');

    await waitFor(() => expect(lastProspectParams()).toMatchObject({ search: 'acme' }));
  });

  it('adds the ticked prospects to a list', async () => {
    const user = userEvent.setup();
    reach.addListMembers.mockResolvedValue({ data: { added: 2 } });
    renderWithApp(<ReachProspectsPage />);
    await screen.findByText('Ana Jansen');

    await user.click(screen.getByRole('checkbox', { name: 'Select ana@acme.com' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select info@widgets.nl' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Events/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add to list' }));

    await waitFor(() => expect(reach.addListMembers).toHaveBeenCalledWith('lst_2', ['prs_ana', 'prs_info']));
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument());
  });

  it('selects every shown prospect at once', async () => {
    const user = userEvent.setup();
    renderWithApp(<ReachProspectsPage />);
    await screen.findByText('Ana Jansen');

    await user.click(screen.getByRole('checkbox', { name: 'Select all shown' }));

    expect(screen.getByText('3 selected')).toBeInTheDocument();
  });

  it('creates a list and adds the ticked prospects to it in one go', async () => {
    const user = userEvent.setup();
    reach.createList.mockResolvedValue({ data: { ...lists[0], id: 'lst_new', name: 'Fresh' } });
    reach.addListMembers.mockResolvedValue({ data: { added: 1 } });
    renderWithApp(<ReachProspectsPage />);
    await screen.findByText('Ana Jansen');

    await user.click(screen.getByRole('checkbox', { name: 'Select ana@acme.com' }));
    await user.click(screen.getByRole('button', { name: 'Add to list' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'New list…' }));
    await user.type(within(dialog).getByLabelText('Name'), 'Fresh');
    await user.click(within(dialog).getByRole('button', { name: 'Add to list' }));

    await waitFor(() => expect(reach.createList).toHaveBeenCalledWith({ name: 'Fresh' }));
    await waitFor(() => expect(reach.addListMembers).toHaveBeenCalledWith('lst_new', ['prs_ana']));
  });

  it('deletes a prospect only after confirmation', async () => {
    const user = userEvent.setup();
    reach.deleteProspect.mockResolvedValue(undefined);
    renderWithApp(<ReachProspectsPage />);
    await screen.findByText('Ana Jansen');

    const row = screen.getByText('Ana Jansen').closest('.group') as HTMLElement;
    // The row's last button is its options menu (the first stretches over the row).
    await user.click(within(row).getAllByRole('button').at(-1) as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete prospect?')).toBeInTheDocument();
    expect(reach.deleteProspect).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(reach.deleteProspect).toHaveBeenCalledWith('prs_ana'));
  });

  it('shows the empty state with an import shortcut when there are no prospects', async () => {
    reach.listProspects.mockResolvedValue(page([]));
    renderWithApp(<ReachProspectsPage />);

    expect(await screen.findByText('No prospects yet')).toBeInTheDocument();
    expect(screen.getByText(/WeldReach is for business addresses only/)).toBeInTheDocument();
  });

  it('hides add, import and list management without the create permission', async () => {
    permissions.granted = new Set(['reach_prospects:read']);
    renderWithApp(<ReachProspectsPage />);
    await screen.findByText('Ana Jansen');

    expect(screen.queryByRole('button', { name: 'Add prospect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New list' })).not.toBeInTheDocument();
  });
});
