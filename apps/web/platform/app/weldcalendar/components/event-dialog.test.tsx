import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const createMeeting = vi.hoisted(() => vi.fn());
const cancelMeeting = vi.hoisted(() => vi.fn());
const createEvent = vi.hoisted(() => vi.fn());
const updateEvent = vi.hoisted(() => vi.fn());

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ orgId: 'org_123' }) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'org_123' }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get: vi.fn() }) }),
}));
vi.mock('@/hooks/queries/use-weldmeet-queries', () => ({
  useCreateMeeting: () => ({ mutateAsync: createMeeting, isPending: false }),
  useCancelMeeting: () => ({ mutateAsync: cancelMeeting, isPending: false }),
}));
vi.mock('@/hooks/queries/use-calendar-queries', () => ({
  useCreateCalendarEvent: () => ({ mutateAsync: createEvent, isPending: false }),
  useUpdateCalendarEvent: () => ({ mutateAsync: updateEvent, isPending: false }),
  useDeleteCalendarEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./location-autocomplete', () => ({
  LocationAutocomplete: ({ id }: { id?: string }) => <input id={id} />,
}));

import { EventDialog } from './event-dialog';

const calendars = [{ id: 'cal_1', name: 'Work', isOwn: true, permission: 'manage' as const, ownerId: 'u1' }];

// The labels are not tied to the switches; the virtual-meeting switch is the second one (after "All day").
const virtualSwitch = () => screen.getAllByRole('switch')[1];

function renderDialog(props: Partial<React.ComponentProps<typeof EventDialog>> = {}) {
  const onOpenChange = vi.fn();
  render(
    <EventDialog
      open
      onOpenChange={onOpenChange}
      calendars={calendars}
      defaultCalendarId="cal_1"
      defaultTitle="Planning"
      defaultStart={new Date('2026-10-05T09:00:00.000Z')}
      defaultEnd={new Date('2026-10-05T10:00:00.000Z')}
      {...props}
    />,
  );
  return { onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  createMeeting.mockResolvedValue({ id: 'mtg_1', joinCode: 'abc-defg-hij' });
  cancelMeeting.mockResolvedValue(undefined);
  createEvent.mockResolvedValue({ data: { id: 'evt_1', weldMeetingLinked: true } });
  updateEvent.mockResolvedValue({ data: { id: 'evt_1', weldMeetingLinked: true } });
});

describe('EventDialog virtual meeting', () => {
  it('makes no API call when the switch is toggled and shows the pending hint', () => {
    renderDialog();

    fireEvent.click(virtualSwitch());

    expect(screen.getByText('The link is created when you save')).toBeInTheDocument();
    expect(createMeeting).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('creates the meeting on submit, then saves the event with its link and id', async () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(virtualSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Planning',
        scheduledStart: '2026-10-05T09:00:00.000Z',
        scheduledEnd: '2026-10-05T10:00:00.000Z',
        accessType: 'anyone_with_link',
        waitingRoom: true,
        allowRecording: false,
      }),
    );
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        isVirtual: true,
        weldMeetingId: 'mtg_1',
        meetingUrl: expect.stringContaining('abc-defg-hij'),
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('cancels the meeting and keeps the dialog open when the event cannot be saved', async () => {
    createEvent.mockRejectedValue(new Error('boom'));
    const { onOpenChange } = renderDialog();

    fireEvent.click(virtualSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(cancelMeeting).toHaveBeenCalledWith({ id: 'mtg_1' }));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(toastMock.error).toHaveBeenCalled();
  });

  it('creates no meeting when the dialog is submitted without the switch', async () => {
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createMeeting).not.toHaveBeenCalled();
    expect(createEvent.mock.calls[0][0]).not.toHaveProperty('weldMeetingId');
  });

  it('clears the link on update when the switch is turned off', async () => {
    renderDialog({
      event: {
        id: 'evt_1',
        calendarId: 'cal_1',
        type: 'meeting',
        title: 'Planning',
        startTime: '2026-10-05T09:00:00.000Z',
        endTime: '2026-10-05T10:00:00.000Z',
        isVirtual: true,
        meetingUrl: 'https://meet.weldsuite.org/org_123/abc-defg-hij',
      },
    });

    fireEvent.click(virtualSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    expect(updateEvent.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ isVirtual: false, meetingUrl: '' }),
    );
    expect(createMeeting).not.toHaveBeenCalled();
  });
});
