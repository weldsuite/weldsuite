/**
 * Calendar delete confirmation (TASK-745), member-picker sharing (TASK-749)
 * and the colour swatch / row menu accessibility (TASK-758).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const deleteCalendar = vi.hoisted(() => vi.fn());
const shareCalendar = vi.hoisted(() => vi.fn());
const removeShare = vi.hoisted(() => vi.fn());
const impact = vi.hoisted(() => ({
  current: { data: { data: { eventCount: 3, eventsWithAttendees: 1 } }, isLoading: false, isError: false },
}));
const shares = vi.hoisted(() => ({
  current: [] as { id: string; calendarId: string; sharedWithId: string; permission: string; sharedById: string }[],
}));

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_me' }) }));
vi.mock('@/hooks/queries/use-calendar-queries', () => ({
  useCalendarDeleteImpact: () => impact.current,
  useDeleteUserCalendar: () => ({ mutateAsync: deleteCalendar, isPending: false }),
  useCalendarShares: () => ({ data: { data: shares.current }, isLoading: false }),
  useShareCalendar: () => ({ mutateAsync: shareCalendar, isPending: false }),
  useRemoveCalendarShare: () => ({ mutateAsync: removeShare, isPending: false }),
  useCreateUserCalendar: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateUserCalendar: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMembers: () => ({
    data: {
      data: [
        { userId: 'user_me', name: 'Me Myself', email: 'me@acme.com', status: 'ACTIVE' },
        { userId: 'user_jan', name: 'Jan Jansen', email: 'jan@acme.com', status: 'ACTIVE' },
        { userId: 'user_piet', name: 'Piet Pieters', email: 'piet@acme.com', status: 'ACTIVE' },
        { userId: 'user_owner', name: 'Olga Owner', email: 'olga@acme.com', status: 'ACTIVE' },
        { userId: 'user_gone', name: 'Gone Member', email: 'gone@acme.com', status: 'SUSPENDED' },
      ],
    },
  }),
  useWorkspaceMemberSearch: () => ({ data: undefined }),
}));

import { DeleteCalendarDialog } from './delete-calendar-dialog';
import { ShareCalendarDialog } from './share-calendar-dialog';
import { CreateCalendarDialog } from './create-calendar-dialog';
import { CalendarSidebarSection } from './calendar-sidebar-section';
import { SidebarProvider } from '@weldsuite/ui/components/sidebar';

beforeEach(() => {
  vi.clearAllMocks();
  deleteCalendar.mockResolvedValue(undefined);
  shareCalendar.mockResolvedValue({ data: { id: 'csh_1' } });
  removeShare.mockResolvedValue(undefined);
  impact.current = {
    data: { data: { eventCount: 3, eventsWithAttendees: 1 } },
    isLoading: false,
    isError: false,
  };
  shares.current = [];
});

describe('DeleteCalendarDialog', () => {
  const calendar = { id: 'cal_qa3', name: 'QA3 Calendar' };

  it('states how many events are deleted and notifies attendees by default', async () => {
    const onOpenChange = vi.fn();
    render(<DeleteCalendarDialog calendar={calendar} onOpenChange={onOpenChange} />);

    expect(screen.getByText(/"QA3 Calendar" and all 3 events in it will be deleted/)).toBeInTheDocument();
    const notify = screen.getByRole('checkbox', { name: /Send cancellation email.*\(1\)/ });
    expect(notify).toHaveAttribute('data-state', 'checked');

    fireEvent.click(screen.getByRole('button', { name: 'Delete calendar' }));

    await waitFor(() =>
      expect(deleteCalendar).toHaveBeenCalledWith({ id: 'cal_qa3', sendNotification: true }),
    );
    expect(toastMock.success).toHaveBeenCalledWith('Calendar "QA3 Calendar" deleted');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('skips the mail when the box is unticked', async () => {
    render(<DeleteCalendarDialog calendar={calendar} onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete calendar' }));
    await waitFor(() =>
      expect(deleteCalendar).toHaveBeenCalledWith({ id: 'cal_qa3', sendNotification: false }),
    );
  });

  it('offers no mail option when no upcoming event has attendees', () => {
    impact.current = {
      data: { data: { eventCount: 0, eventsWithAttendees: 0 } },
      isLoading: false,
      isError: false,
    };
    render(<DeleteCalendarDialog calendar={calendar} onOpenChange={vi.fn()} />);
    expect(screen.getByText(/It has no events/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and shows an error toast when the delete fails', async () => {
    deleteCalendar.mockRejectedValue(new Error('boom'));
    const onOpenChange = vi.fn();
    render(<DeleteCalendarDialog calendar={calendar} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete calendar' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not delete the calendar'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('ShareCalendarDialog', () => {
  function renderShare() {
    render(
      <ShareCalendarDialog calendarId="cal_1" ownerId="user_owner" open onOpenChange={vi.fn()} />,
    );
  }

  it('offers active members only, never yourself, the owner or someone already shared with', () => {
    shares.current = [
      { id: 'csh_p', calendarId: 'cal_1', sharedWithId: 'user_piet', permission: 'view', sharedById: 'user_me' },
    ];
    renderShare();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual([expect.stringContaining('Jan Jansen')]);
  });

  it('shares with the highlighted member on Enter', async () => {
    renderShare();
    const input = screen.getByPlaceholderText('Search members by name or email');
    fireEvent.change(input, { target: { value: 'jan' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(shareCalendar).toHaveBeenCalledWith({
        calendarId: 'cal_1',
        sharedWithId: 'user_jan',
        permission: 'view',
      }),
    );
  });

  it('shares with the highlighted member from the labelled add button', async () => {
    renderShare();
    fireEvent.change(screen.getByPlaceholderText('Search members by name or email'), {
      target: { value: 'piet@' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
    await waitFor(() =>
      expect(shareCalendar).toHaveBeenCalledWith(expect.objectContaining({ sharedWithId: 'user_piet' })),
    );
  });

  it('lists shares by member name and email with a labelled remove button', async () => {
    shares.current = [
      { id: 'csh_j', calendarId: 'cal_1', sharedWithId: 'user_jan', permission: 'edit', sharedById: 'user_me' },
    ];
    renderShare();
    expect(screen.getByText('Jan Jansen')).toBeInTheDocument();
    expect(screen.getByText(/jan@acme\.com · Can edit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Jan Jansen' }));
    await waitFor(() => expect(removeShare).toHaveBeenCalledWith({ calendarId: 'cal_1', shareId: 'csh_j' }));
  });
});

describe('CreateCalendarDialog colour swatches', () => {
  it('names every swatch and marks the selected one as pressed', () => {
    render(<CreateCalendarDialog open onOpenChange={vi.fn()} />);
    const blue = screen.getByRole('button', { name: 'Blue' });
    const red = screen.getByRole('button', { name: 'Red' });
    expect(blue).toHaveAttribute('aria-pressed', 'true');
    expect(red).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(red);
    expect(screen.getByRole('button', { name: 'Red' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(9);
  });
});

describe('CreateCalendarDialog name (TASK-895)', () => {
  it('keeps Create off until the calendar has a name, spaces do not count', () => {
    render(<CreateCalendarDialog open onOpenChange={vi.fn()} />);
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } });
    expect(create).toBeEnabled();
  });
});

describe('CalendarSidebarSection row menu', () => {
  it('opens the row menu from the keyboard and asks before deleting', async () => {
    render(
      <CalendarSidebarSection
        calendars={[
          { id: 'cal_qa3', name: 'QA3 Calendar', ownerId: 'user_me', isOwn: true, permission: 'manage' },
        ]}
      />,
      { wrapper: SidebarProvider },
    );
    const trigger = screen.getByRole('button', { name: 'Options for QA3 Calendar' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(deleteCalendar).not.toHaveBeenCalled();
  });

  it('renders no menu for a calendar shared with view access', () => {
    render(
      <CalendarSidebarSection
        calendars={[
          { id: 'cal_s', name: 'Team', ownerId: 'user_other', isOwn: false, permission: 'view' },
        ]}
      />,
      { wrapper: SidebarProvider },
    );
    expect(screen.queryByRole('button', { name: 'Options for Team' })).not.toBeInTheDocument();
  });
});
