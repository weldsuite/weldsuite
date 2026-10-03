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
// The real picker queries people / members; the dialog only needs its props API.
vi.mock('./guest-search-input', () => ({
  GuestSearchInput: ({ onSelect }: { onSelect: (g: { id: string; name: string; email: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ id: 'member-1', name: 'Ada Lovelace', email: 'ada@example.com' })}>
      pick-ada
    </button>
  ),
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

const baseEvent = {
  id: 'evt_1',
  calendarId: 'cal_1',
  type: 'meeting' as const,
  title: 'Planning',
  startTime: '2026-10-05T09:00:00.000Z',
  endTime: '2026-10-05T10:00:00.000Z',
};

/** What the API returns for a quick-created event: every unset column is null. */
const nullColumns = {
  tags: null,
  attendees: null,
  description: null,
  location: null,
  meetingUrl: null,
  customerId: null,
  contactId: null,
  notes: null,
  color: null,
} as unknown as Partial<React.ComponentProps<typeof EventDialog>['event']>;

describe('EventDialog update (TASK-731)', () => {
  it('saves an event whose unset columns are null instead of failing validation silently', async () => {
    const { onOpenChange } = renderDialog({ event: { ...baseEvent, ...nullColumns } as never });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Planning v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    const call = updateEvent.mock.calls[0][0];
    expect(call.id).toBe('evt_1');
    expect(call.data).toEqual(expect.objectContaining({ title: 'Planning v2', startTime: expect.any(String) }));
    // The server's schema rejects null, so no field may carry one.
    expect(Object.values(call.data)).not.toContain(null);
    expect(call.data.timezone).toEqual(expect.any(String));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows an error summary when a field the dialog has no spot for is invalid', async () => {
    renderDialog({
      event: { ...baseEvent, attendees: [{ email: 'not-an-email' }] } as never,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Guests');
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('rolls an end before the start on the same day over midnight', async () => {
    renderDialog({
      event: { ...baseEvent, startTime: '2026-10-05T21:00:00.000Z', endTime: '2026-10-05T22:00:00.000Z' } as never,
    });

    const start = (screen.getByLabelText('Start') as HTMLInputElement).value; // local 'YYYY-MM-DDTHH:mm'
    const day = start.slice(0, 10);
    fireEvent.change(screen.getByLabelText('End'), { target: { value: `${day}T00:30` } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    const { startTime, endTime } = updateEvent.mock.calls[0][0].data;
    expect(new Date(endTime).getTime()).toBeGreaterThan(new Date(startTime).getTime());
    expect(new Date(endTime).getTime() - new Date(startTime).getTime()).toBeLessThan(24 * 3_600_000);
  });

  it('refuses an end on an earlier day with a validation error and no request', async () => {
    renderDialog({ event: baseEvent as never });

    const start = (screen.getByLabelText('Start') as HTMLInputElement).value;
    const prevDay = new Date(`${start.slice(0, 10)}T00:00:00`);
    prevDay.setDate(prevDay.getDate() - 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    const value = `${prevDay.getFullYear()}-${pad(prevDay.getMonth() + 1)}-${pad(prevDay.getDate())}T10:00`;
    fireEvent.change(screen.getByLabelText('End'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(await screen.findByText('End must be after start')).toBeInTheDocument();
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('keeps the duration when the start moves', async () => {
    renderDialog({ event: baseEvent as never });

    const startInput = screen.getByLabelText('Start') as HTMLInputElement;
    const endBefore = (screen.getByLabelText('End') as HTMLInputElement).value;
    const [day, time] = startInput.value.split('T');
    const [h, m] = time.split(':').map(Number);
    const newStart = `${day}T${String((h + 2) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    fireEvent.change(startInput, { target: { value: newStart } });

    expect((screen.getByLabelText('End') as HTMLInputElement).value).not.toBe(endBefore);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    const { startTime, endTime } = updateEvent.mock.calls[0][0].data;
    expect(new Date(endTime).getTime() - new Date(startTime).getTime()).toBe(3_600_000);
  });

  it('does not leak a cancelled edit into the next time the dialog opens', () => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      calendars,
      defaultCalendarId: 'cal_1',
      event: baseEvent as never,
    };
    const { rerender } = render(<EventDialog {...props} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed then cancelled' } });
    rerender(<EventDialog {...props} open={false} />);
    rerender(<EventDialog {...props} open />);
    expect(screen.getByLabelText('Title')).toHaveValue('Planning');
  });
});

describe('EventDialog guests', () => {
  it('adds a guest, asks the notify question, and sends the list with the answer', async () => {
    renderDialog({ event: baseEvent as never });

    fireEvent.click(screen.getByRole('button', { name: 'Add guests' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick-ada' }));
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    // An event with no guests before still asks: the new guest is mailed only on "yes".
    expect(await screen.findByText('Update event')).toBeInTheDocument();
    expect(updateEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    const call = updateEvent.mock.calls[0][0];
    expect(call.sendNotification).toBe(true);
    expect(call.data.attendees).toEqual([expect.objectContaining({ email: 'ada@example.com', name: 'Ada Lovelace' })]);
  });

  it('removes a guest and still sends the (now empty) list', async () => {
    renderDialog({
      event: { ...baseEvent, attendees: [{ email: 'bob@example.com', name: 'Bob' }] } as never,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    expect(updateEvent.mock.calls[0][0].data.attendees).toEqual([]);
  });
});
