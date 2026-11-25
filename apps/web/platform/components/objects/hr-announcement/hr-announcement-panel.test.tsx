import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrAnnouncement, HrAnnouncementRead } from '@weldsuite/app-api-client/domains/weldhr';

const deleteAsync = vi.fn();
const refetchAnnouncements = vi.fn();
const refetchReads = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const writeText = vi.fn();
const permissions = new Set<string>();

interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
}
let announcements: QueryState<HrAnnouncement[]>;
let reads: QueryState<HrAnnouncementRead[]>;
let employees: Array<{ id: string; departmentName: string | null; avatarUrl: string | null }> = [];

vi.mock('@/components/object-panel', async () => ({
  ...(await import('@/components/objects/_shared/object-panel-test-mock')),
  useObjectPanelNavigationReporter: () => () => {},
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({
  toast: { success: (message: string) => toastSuccess(message), error: (message: string) => toastError(message) },
}));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.example.com/w/acme${path}` }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrAnnouncements: () => ({ ...announcements, refetch: refetchAnnouncements }),
  useHrAnnouncementReads: () => ({ ...reads, refetch: refetchReads }),
  useDeleteHrAnnouncement: () => ({ mutateAsync: deleteAsync, isPending: false }),
  useHrEmployees: () => ({ data: { data: employees } }),
}));
vi.mock('@/app/weldhr/announcements/components/announcement-dialog', () => ({
  AnnouncementDialog: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Close the editor
    </button>
  ),
}));

import { HrAnnouncementPanel } from './hr-announcement-panel';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeAnnouncement(extra: Partial<HrAnnouncement> = {}): HrAnnouncement {
  return {
    id: 'ann_1',
    title: 'Office closed',
    body: 'Line one\nLine two <b>not markup</b>',
    pinned: false,
    departmentIds: [],
    departmentNames: [],
    publishedAt: '2026-11-10T09:00:00.000Z',
    notifiedAt: null,
    createdBy: null,
    createdByName: null,
    audienceCount: 3,
    readCount: 1,
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    ...extra,
  };
}

const READS: HrAnnouncementRead[] = [
  { employeeId: 'hremp_ann', employeeName: 'Ann Archer', readAt: '2026-11-11T10:00:00.000Z' },
  { employeeId: 'hremp_bob', employeeName: 'Bob Baker', readAt: null },
  { employeeId: 'hremp_cy', employeeName: 'Cy Chase', readAt: null },
];

function renderPanel(props: { initialTab?: string; onClose?: () => void } = {}) {
  return renderWithProviders(
    <HrAnnouncementPanel
      id="ann_1"
      isOpen
      onClose={props.onClose ?? vi.fn()}
      mode="fullscreen"
      onModeChange={vi.fn()}
      initialTab={props.initialTab}
    />,
  );
}

describe('HrAnnouncementPanel', () => {
  beforeEach(() => {
    deleteAsync.mockReset().mockResolvedValue({});
    refetchAnnouncements.mockReset();
    refetchReads.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    writeText.mockReset().mockResolvedValue(undefined);

    panelOpen.mockReset();
    permissions.clear();
    announcements = { data: [makeAnnouncement()], isLoading: false, error: null };
    reads = { data: READS, isLoading: false, error: null };
    employees = [
      { id: 'hremp_ann', departmentName: 'Shop', avatarUrl: null },
      { id: 'hremp_bob', departmentName: 'Office', avatarUrl: null },
    ];
  });

  it('shows the announcement for everyone, with the message kept as plain text', () => {
    renderPanel();

    expect(screen.getAllByText('Office closed').length).toBeGreaterThan(0);
    expect(screen.getByText('Everyone')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByText(/Line two <b>not markup<\/b>/)).toBeInTheDocument();
    // Not edited, no push, nobody posted it.
    expect(screen.queryByText('Updated')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByLabelText('Pinned')).not.toBeInTheDocument();
  });

  it('shows a pinned, edited announcement for departments, with who posted it and its push', () => {
    announcements = {
      data: [
        makeAnnouncement({
          pinned: true,
          departmentNames: ['Shop', 'Office'],
          notifiedAt: '2026-11-10T09:05:00.000Z',
          createdByName: 'Bea Boss',
          updatedAt: '2026-11-12T09:00:00.000Z',
        }),
      ],
      isLoading: false,
      error: null,
    };
    renderPanel();

    expect(screen.getByText('Shop, Office')).toBeInTheDocument();
    expect(screen.getByText('Bea Boss')).toBeInTheDocument();
    expect(screen.getByLabelText('Pinned')).toBeInTheDocument();
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('counts the tabs from the read list, and from the announcement until the list is there', () => {
    const first = renderPanel();
    expect(screen.getByRole('tab', { name: /Not read/ })).toHaveTextContent('Not read');
    first.unmount();

    reads = { data: undefined, isLoading: true, error: null };
    announcements = { data: [makeAnnouncement({ audienceCount: 5, readCount: 2 })], isLoading: false, error: null };
    renderPanel();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Details', expect.stringContaining('Not read'), expect.stringContaining('Read')]);
  });

  it('lists who has not read it, with their department, and opens one on top', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('tab', { name: /Not read/ }));
    expect(screen.getByText('Bob Baker')).toBeInTheDocument();
    expect(screen.getByText('Cy Chase')).toBeInTheDocument();
    expect(screen.queryByText('Ann Archer')).not.toBeInTheDocument();
    expect(screen.getByText('Office')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Bob Baker' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'hr_employee', id: 'hremp_bob', stack: true });
  });

  it('lists who has read it with when, and narrows the list by search', async () => {
    const user = userEvent.setup();
    renderPanel({ initialTab: 'read' });

    expect(screen.getByText('Ann Archer')).toBeInTheDocument();
    expect(screen.getByText('Shop')).toBeInTheDocument();
    expect(screen.queryByText('Bob Baker')).not.toBeInTheDocument();
    expect(screen.getByText(/11 Nov|Nov 11|11\/11/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Search/ }));
    await user.type(screen.getAllByPlaceholderText(/Search/)[0], 'zzz');
    expect(screen.queryByText('Ann Archer')).not.toBeInTheDocument();
  });

  it('opens on the Not read tab when asked to', () => {
    renderPanel({ initialTab: 'notRead' });

    expect(screen.getByText('Bob Baker')).toBeInTheDocument();
    expect(screen.queryByText('Line one')).not.toBeInTheDocument();
  });

  it('shows the empty state of a tab nobody is on', async () => {
    reads = { data: [{ employeeId: 'hremp_ann', employeeName: 'Ann Archer', readAt: null }], isLoading: false, error: null };
    renderPanel({ initialTab: 'read' });

    expect(screen.queryByText('Ann Archer')).not.toBeInTheDocument();
    expect(screen.getByText(/nobody|no one|hasn.t/i)).toBeInTheDocument();
  });

  it('filters the list by department', async () => {
    const user = userEvent.setup();
    reads = {
      data: [
        { employeeId: 'hremp_ann', employeeName: 'Ann Archer', readAt: '2026-11-11T10:00:00.000Z' },
        { employeeId: 'hremp_bob', employeeName: 'Bob Baker', readAt: '2026-11-11T11:00:00.000Z' },
      ],
      isLoading: false,
      error: null,
    };
    renderPanel({ initialTab: 'read' });

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await vi.waitFor(() => expect(screen.getAllByText('Department')).toHaveLength(2));
    await user.click(screen.getAllByText('Department')[1]);
    await user.click(await screen.findByText('is', { exact: true }));
    await vi.waitFor(() => expect(screen.queryByText('is not')).not.toBeInTheDocument());
    // The value picker opens by itself after the condition; open it when it has not (yet).
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (screen.queryAllByText('Shop').length < 2) await user.click(screen.getByText(/Select department/i));
    await vi.waitFor(() => expect(screen.getAllByText('Shop').length).toBeGreaterThan(1));
    await user.click(screen.getAllByText('Shop').at(-1)!);
    expect(screen.getByText('Ann Archer')).toBeInTheDocument();
    expect(screen.queryByText('Bob Baker')).not.toBeInTheDocument();
  });

  it('shows a spinner while the read list loads', async () => {
    reads = { data: undefined, isLoading: true, error: null };
    renderPanel({ initialTab: 'read' });

    expect(screen.queryByText('Ann Archer')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('says so when the read list could not be loaded, and retries', async () => {
    reads = { data: undefined, isLoading: false, error: new Error('Reads unavailable') };
    const user = userEvent.setup();
    renderPanel({ initialTab: 'notRead' });

    expect(screen.getByText('Reads unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchReads).toHaveBeenCalled();
  });

  it('shows placeholders while the announcements load', () => {
    announcements = { data: undefined, isLoading: true, error: null };
    renderPanel();

    expect(screen.queryByText('Office closed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('says so when the announcement is gone', () => {
    announcements = { data: [], isLoading: false, error: null };
    renderPanel();

    expect(screen.getByText(/not found|no longer|doesn.t exist/i)).toBeInTheDocument();
  });

  it('says so when the announcements could not be loaded, and retries', async () => {
    announcements = { data: undefined, isLoading: false, error: new Error('Server unavailable') };
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByText('Server unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchAnnouncements).toHaveBeenCalled();
  });

  it('copies the link to the announcement from the menu, for any member', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Edit announcement' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: /Copy link/ }));

    expect(writeText).toHaveBeenCalledWith('https://app.example.com/w/acme/weldhr/announcements?stack=hr_announcement:ann_1');
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it('says so when the link could not be copied', async () => {
    writeText.mockRejectedValue(new Error('Denied'));
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Copy link/ }));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('opens the editor from the menu, and closes it again', async () => {
    permissions.add('announcements:update');
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: /Edit/ }));
    await user.click(screen.getByRole('button', { name: 'Close the editor' }));
    expect(screen.queryByRole('button', { name: 'Close the editor' })).not.toBeInTheDocument();
  });

  it('deletes the announcement after asking, and closes the panel', async () => {
    permissions.add('announcements:delete');
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPanel({ onClose });

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Office closed');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(deleteAsync).toHaveBeenCalledWith('ann_1');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('says so when deleting fails, and keeps the panel open', async () => {
    permissions.add('announcements:delete');
    deleteAsync.mockRejectedValue(new Error('In use'));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPanel({ onClose });

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('In use'));
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
