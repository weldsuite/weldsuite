import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';
import WeldHrAnnouncementsPage from './page';
import { latest } from '@/components/panel-entity-list-test-mock';

const t = en.weldhr.announcements;

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  data: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
  remove: vi.fn(),
  openPanel: vi.fn(),
  urlSync: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (p: string) => state.permissions.has(p) }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: state.openPanel }),
  useObjectPanelUrlSync: state.urlSync,
}));
vi.mock('./components/announcement-dialog', () => ({
  AnnouncementDialog: (p: { announcement?: { id: string }; onClose: () => void }) => (
    <button onClick={p.onClose}>{p.announcement ? `edit dialog ${p.announcement.id}` : 'create dialog'}</button>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrAnnouncements: () => ({ data: state.data, isLoading: state.isLoading, error: state.error }),
  useDeleteHrAnnouncement: () => ({ mutateAsync: state.remove }),
}));

function announcement(over: Partial<HrAnnouncement> & { id: string }): HrAnnouncement {
  return {
    title: `Title ${over.id}`,
    body: 'Body',
    pinned: false,
    departmentIds: [],
    departmentNames: [],
    publishedAt: '2026-11-20T09:00:00Z',
    notifiedAt: null,
    createdBy: null,
    createdByName: null,
    audienceCount: 10,
    readCount: 4,
    createdAt: '2026-11-20T09:00:00Z',
    updatedAt: '2026-11-20T09:00:00Z',
    ...over,
  };
}

function renderPage() {
  return render(
    <I18nProvider initialLanguage="en">
      <WeldHrAnnouncementsPage />
    </I18nProvider>,
  );
}

beforeEach(() => {
  state.permissions = new Set(['announcements:create', 'announcements:update', 'announcements:delete']);
  state.isLoading = false;
  state.error = null;
  state.remove.mockReset().mockResolvedValue(undefined);
  state.openPanel.mockReset();
  state.urlSync.mockReset();
  vi.mocked(toast.error).mockReset();
  state.data = [
    announcement({ id: 'a_pinned', title: 'Office move', pinned: true, notifiedAt: '2026-11-20T09:05:00Z', departmentNames: ['Sales', 'Support'], createdByName: 'Eva' }),
    announcement({ id: 'a_plain', title: 'Lunch menu' }),
    announcement({ id: 'a_sales', title: 'Sales kickoff', departmentNames: ['Sales'], createdByName: 'Bram' }),
  ];
});

describe('WeldHrAnnouncementsPage', () => {
  it('syncs the open panel with the URL and groups pinned announcements first', () => {
    renderPage();
    expect(state.urlSync).toHaveBeenCalledWith('/weldhr/announcements');
    expect(within(screen.getByRole('region', { name: t.groups.pinned })).getByTestId('row-a_pinned')).toBeInTheDocument();
    const others = within(screen.getByRole('region', { name: t.groups.other }));
    expect(others.getByTestId('row-a_plain')).toBeInTheDocument();
    expect(others.getByTestId('row-a_sales')).toBeInTheDocument();
  });

  it('shows the pin and push markers, the audience and the read count', () => {
    renderPage();
    const pinned = within(screen.getByTestId('row-a_pinned'));
    expect(pinned.getByLabelText(t.pinned)).toBeInTheDocument();
    expect(pinned.getByLabelText(t.pushSent)).toBeInTheDocument();
    expect(pinned.getAllByText('Sales, Support').length).toBeGreaterThan(0);
    expect(pinned.getAllByText('4 of 10').length).toBeGreaterThan(0);

    const plain = within(screen.getByTestId('row-a_plain'));
    expect(plain.queryByLabelText(t.pinned)).not.toBeInTheDocument();
    expect(plain.queryByLabelText(t.pushSent)).not.toBeInTheDocument();
    expect(plain.getAllByText(t.everyone).length).toBeGreaterThan(0);
  });

  it('shows loading, error and the empty state with its create action', async () => {
    const user = userEvent.setup();
    state.isLoading = true;
    const first = renderPage();
    expect(screen.getByText('loading')).toBeInTheDocument();
    first.unmount();

    state.isLoading = false;
    state.error = new Error('Server down');
    const second = renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Server down');
    second.unmount();

    state.error = null;
    state.data = [];
    renderPage();
    expect(screen.getByText(t.empty.title)).toBeInTheDocument();
    // The toolbar button and the empty-state action carry the same label.
    const buttons = screen.getAllByRole('button', { name: t.add });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    expect(screen.getByRole('button', { name: 'create dialog' })).toBeInTheDocument();
  });

  it('treats a missing list as empty', () => {
    state.data = undefined;
    renderPage();
    expect(screen.getByText(t.empty.title)).toBeInTheDocument();
  });

  it('opens the announcement panel from a row', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'open a_sales' }));
    expect(state.openPanel).toHaveBeenCalledWith({ type: 'hr_announcement', id: 'a_sales' });
  });

  it('searches by title', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText('search'), '  lunch ');
    expect(screen.getByTestId('row-a_plain')).toBeInTheDocument();
    expect(screen.queryByTestId('row-a_pinned')).not.toBeInTheDocument();
  });

  it('offers Everyone, each department and both pin states as filters', () => {
    renderPage();
    const audience = within(screen.getByRole('group', { name: 'filter audience' }));
    expect(audience.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'audience=__everyone',
      'audience=Sales',
      'audience=Support',
    ]);
    expect(within(screen.getByRole('group', { name: 'filter pinned' })).getAllByRole('button')).toHaveLength(2);
    expect(within(screen.getByRole('group', { name: 'filter postedBy' })).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'postedBy=Bram',
      'postedBy=Eva',
    ]);
  });

  it('has no posted-by filter when nobody is named as the author', () => {
    state.data = [announcement({ id: 'a_plain' })];
    renderPage();
    expect(screen.queryByRole('group', { name: 'filter postedBy' })).not.toBeInTheDocument();
  });

  it('filters to announcements for everyone', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'audience=__everyone' }));
    expect(screen.getByTestId('row-a_plain')).toBeInTheDocument();
    expect(screen.queryByTestId('row-a_pinned')).not.toBeInTheDocument();
    expect(screen.queryByTestId('row-a_sales')).not.toBeInTheDocument();
  });

  it('filters by department, matching one of several', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'audience=Sales' }));
    expect(screen.getByTestId('row-a_pinned')).toBeInTheDocument();
    expect(screen.getByTestId('row-a_sales')).toBeInTheDocument();
    expect(screen.queryByTestId('row-a_plain')).not.toBeInTheDocument();
  });

  it('filters by pinned state and by author', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'pinned=pinned' }));
    expect(screen.getByTestId('row-a_pinned')).toBeInTheDocument();
    expect(screen.queryByTestId('row-a_plain')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'pinned=notPinned' }));
    expect(screen.queryByTestId('row-a_pinned')).not.toBeInTheDocument();
    expect(screen.getByTestId('row-a_plain')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'postedBy=Bram' }));
    expect(screen.getByTestId('row-a_sales')).toBeInTheDocument();
    expect(screen.queryByTestId('row-a_plain')).not.toBeInTheDocument();
  });

  it('creates, edits and closes the dialog', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: t.add }));
    await user.click(screen.getByRole('button', { name: 'create dialog' }));
    expect(screen.queryByRole('button', { name: 'create dialog' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'edit a_plain' }));
    expect(screen.getByRole('button', { name: 'edit dialog a_plain' })).toBeInTheDocument();
  });

  it('deletes after confirming and names the announcement', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'delete a_plain' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete "Lunch menu"? Employees will no longer see it.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: en.weldhr.common.delete }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('a_plain'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the announcement when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'delete a_plain' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: en.weldhr.common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(state.remove).not.toHaveBeenCalled();
  });

  it('shows the error when deleting fails', async () => {
    state.remove.mockRejectedValue(new Error('In use'));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'delete a_plain' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: en.weldhr.common.delete }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('In use'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('hides create, edit and delete without the permissions', () => {
    state.permissions = new Set();
    renderPage();
    expect(screen.queryByRole('button', { name: t.add })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'edit a_plain' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'delete a_plain' })).not.toBeInTheDocument();
  });

  it('has no empty-state action without the create permission', () => {
    state.permissions = new Set();
    state.data = [];
    renderPage();
    expect(screen.getByText(t.empty.title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.add })).not.toBeInTheDocument();
  });

  it('leaves the rows alone for a filter without a value or on an unknown field', () => {
    renderPage();
    const rows = state.data as unknown[] as never[];
    expect(latest.applyFilters?.(rows, [{ id: 'a', field: 'status', operator: 'is', value: '' }])).toHaveLength(rows.length);
    expect(latest.applyFilters?.(rows, [{ id: 'b', field: 'unknown', operator: 'is', value: 'x' }])).toHaveLength(rows.length);
  });
});
