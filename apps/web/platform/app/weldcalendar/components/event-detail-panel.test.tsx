import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const createMeeting = vi.hoisted(() => vi.fn());
const cancelMeeting = vi.hoisted(() => vi.fn());
const updateMutate = vi.hoisted(() => vi.fn());
const updateMutateAsync = vi.hoisted(() => vi.fn());
const deleteMutateAsync = vi.hoisted(() => vi.fn());

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ orgId: 'org_123' }),
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: 'me@acme.com' } } }),
}));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'org_123' }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get: vi.fn() }) }),
}));
vi.mock('@/hooks/queries/use-weldmeet-queries', () => ({
  useCreateMeeting: () => ({ mutateAsync: createMeeting, isPending: false }),
  useCancelMeeting: () => ({ mutateAsync: cancelMeeting, isPending: false }),
}));
vi.mock('@/hooks/queries/use-calendar-queries', () => ({
  useCreateCalendarEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateCalendarEvent: () => ({ mutate: updateMutate, mutateAsync: updateMutateAsync, isPending: false }),
  useDeleteCalendarEvent: () => ({ mutateAsync: deleteMutateAsync, isPending: false }),
  useRescheduleCalendarEvent: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUnpinCalendarEvent: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useCalendarEventsRange: () => ({ data: undefined }),
  useSearchCalendarEvents: () => ({ data: undefined, isFetching: false }),
  useUserCalendars: () => ({ data: { data: [] } }),
}));
vi.mock('@/hooks/use-crm-tasks', () => ({
  useCreateTask: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMembers: () => ({ data: { data: [] } }),
  useWorkingHours: () => ({ data: undefined }),
  useUserPreferences: () => ({ data: undefined }),
}));
vi.mock('@/components/objects/person/use-person-data', () => ({
  usePeople: () => ({ data: { data: [] }, people: [] }),
}));
vi.mock('./location-autocomplete', () => ({
  LocationAutocomplete: () => <input />,
}));

import { EventDetailPanel } from './calendar-view';

const calendars = [
  { id: 'cal_1', name: 'Work', isOwn: true, permission: 'manage' as const, ownerId: 'u1' },
  { id: 'cal_2', name: 'Team (edit)', isOwn: false, permission: 'edit' as const, ownerId: 'u2' },
  { id: 'cal_3', name: 'Holidays (view)', isOwn: false, permission: 'view' as const, ownerId: 'u3' },
];

const baseEvent = {
  id: 'evt_1',
  calendarId: 'cal_1',
  type: 'meeting' as const,
  title: 'Planning',
  description: 'First line\nSecond line',
  startTime: '2026-10-05T09:00:00.000Z',
  endTime: '2026-10-05T10:00:00.000Z',
  status: 'confirmed',
  priority: 'normal',
};

let slot: HTMLElement;

function renderPanel(event: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  render(
    <EventDetailPanel
      event={{ ...baseEvent, ...event } as never}
      isOpen
      calendars={calendars}
      calendarColorMap={{}}
      width={380}
      onClose={onClose}
      onEdit={vi.fn()}
    />,
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  slot = document.createElement('div');
  slot.id = 'weldcalendar-event-panel-slot';
  document.body.appendChild(slot);
  createMeeting.mockResolvedValue({ id: 'mtg_1', joinCode: 'abc-defg-hij' });
  cancelMeeting.mockResolvedValue(undefined);
  updateMutateAsync.mockResolvedValue({ data: { id: 'evt_1', weldMeetingLinked: true } });
  deleteMutateAsync.mockResolvedValue({});
});

afterEach(() => {
  slot.remove();
});

/** Opens a field's popover and picks an option by its visible name. */
function pick(fieldValue: RegExp | string, option: string) {
  fireEvent.click(screen.getByRole('button', { name: fieldValue }));
  fireEvent.click(screen.getByRole('button', { name: option }));
}

describe('EventDetailPanel status (TASK-887)', () => {
  it('shows the stored status and saves a new one, closing the popover', async () => {
    renderPanel({ status: 'tentative' });

    expect(screen.getByRole('button', { name: 'Tentative' })).toBeInTheDocument();
    pick('Tentative', 'Cancelled');

    expect(updateMutate).toHaveBeenCalledWith({ id: 'evt_1', data: { status: 'cancelled' } }, expect.any(Object));
    // The popover closed: its other options are gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirmed' })).not.toBeInTheDocument());
  });
});

describe('EventDetailPanel status with guests (TASK-935)', () => {
  const withGuest = { attendees: [{ email: 'guest@example.com', name: 'Guest' }] };

  it('asks whether to notify before cancelling, and sends the cancellation by default', async () => {
    renderPanel(withGuest);

    pick('Confirmed', 'Cancelled');
    // Nothing is saved until the dialog is answered.
    expect(updateMutate).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Send cancellation email to all participants')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel event' }));
    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'evt_1', data: { status: 'cancelled' }, sendNotification: true },
      expect.any(Object),
    );
  });

  it('cancels without mail when the checkbox is cleared', async () => {
    renderPanel(withGuest);

    pick('Confirmed', 'Cancelled');
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel event' }));

    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'evt_1', data: { status: 'cancelled' }, sendNotification: false },
      expect.any(Object),
    );
  });

  it('leaves the event as it was when the dialog is dismissed', async () => {
    renderPanel(withGuest);

    pick('Confirmed', 'Cancelled');
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep event' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('asks whether to tell guests a cancelled event is on again', async () => {
    renderPanel({ ...withGuest, status: 'cancelled' });

    pick('Cancelled', 'Confirmed');
    expect(updateMutate).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Let all participants know the event is on again')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'evt_1', data: { status: 'confirmed' }, sendNotification: true },
      expect.any(Object),
    );
  });

  it('saves confirmed <-> tentative at once: guests are still expected either way', () => {
    renderPanel(withGuest);
    pick('Confirmed', 'Tentative');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(updateMutate).toHaveBeenCalledWith({ id: 'evt_1', data: { status: 'tentative' } }, expect.any(Object));
  });
});

describe('EventDetailPanel selectors (TASK-888, TASK-895)', () => {
  it('names the type like the toolbar filter and closes the popover on select', async () => {
    renderPanel({ type: 'reminder' });

    expect(screen.getByRole('button', { name: 'Task' })).toBeInTheDocument();
    pick('Task', 'Call');

    expect(updateMutate).toHaveBeenCalledWith({ id: 'evt_1', data: { type: 'call' } }, expect.any(Object));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Appointment' })).not.toBeInTheDocument());
  });

  it('lists only calendars the user may write to and reports a refused move', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    expect(screen.getByRole('button', { name: 'Team (edit)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Holidays (view)' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Team (edit)' }));
    expect(updateMutate).toHaveBeenCalledWith({ id: 'evt_1', data: { calendarId: 'cal_2' } }, expect.any(Object));
    // A failed update is surfaced with a toast.
    const options = updateMutate.mock.calls[0]![1] as { onError: () => void };
    options.onError();
    expect(toastMock.error).toHaveBeenCalledWith('Could not move the event to that calendar.');
  });

  it('sends null when the location is emptied', () => {
    renderPanel({ location: 'Office' });

    fireEvent.click(screen.getByRole('button', { name: 'Office' }));
    const input = screen.getByDisplayValue('Office');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(updateMutate).toHaveBeenCalledWith({ id: 'evt_1', data: { location: null } }, expect.any(Object));
  });

  it('gives the more-actions menu button an accessible name', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });
});

describe('EventDetailPanel description (TASK-888)', () => {
  const startEditing = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add description...' }));
    return screen.getByRole('textbox', { name: 'Add description...' }) as HTMLTextAreaElement;
  };

  it('keeps line breaks when the description is saved', () => {
    renderPanel();

    const field = startEditing();
    expect(field.value).toBe('First line\nSecond line');
    fireEvent.change(field, { target: { value: 'One\nTwo\n\nThree  ' } });
    fireEvent.blur(field);

    expect(updateMutate).toHaveBeenCalledWith({ id: 'evt_1', data: { description: 'One\nTwo\n\nThree' } }, expect.any(Object));
  });

  it('clears the description', () => {
    renderPanel();

    const field = startEditing();
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);

    expect(updateMutate).toHaveBeenCalledWith({ id: 'evt_1', data: { description: '' } }, expect.any(Object));
  });

  it('does not save an edit that was cancelled with Escape', () => {
    renderPanel();

    const field = startEditing();
    fireEvent.change(field, { target: { value: 'typed then cancelled' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.blur(field);

    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe('EventDetailPanel delete (TASK-893)', () => {
  const openMenuAndDelete = () => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete event' }));
  };

  it('asks for confirmation before deleting an event without guests', async () => {
    const { onClose } = renderPanel();

    openMenuAndDelete();
    expect(deleteMutateAsync).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('"Planning" will be deleted');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete event' }));
    await waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledWith({ id: 'evt_1', sendNotification: undefined }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalledWith('Event deleted');
  });

  it('keeps the event open and reports a failed delete', async () => {
    deleteMutateAsync.mockRejectedValue(new Error('boom'));
    const { onClose } = renderPanel();

    openMenuAndDelete();
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete event' }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not delete the event. Please try again.'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the notify dialog for an event with guests', async () => {
    renderPanel({ attendees: [{ email: 'bob@acme.com', name: 'Bob' }] });

    openMenuAndDelete();

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Send cancellation email to all participants');
  });
});

describe('EventDetailPanel guests (TASK-893)', () => {
  const guests = [
    { email: 'bob@acme.com', name: 'Bob' },
    { email: 'cy@acme.com', name: 'Cy' },
  ];

  it('asks whether to notify before removing a guest, then sends the answer', async () => {
    renderPanel({ attendees: guests });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob' }));
    expect(updateMutate).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Remove Bob?');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove without notifying' }));
    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'evt_1', data: { attendees: [{ email: 'cy@acme.com', name: 'Cy' }] }, sendNotification: false },
      expect.any(Object),
    );
  });

  it('notifies on "Remove and notify" and does nothing on Cancel', async () => {
    renderPanel({ attendees: guests });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Cy' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(updateMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Cy' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove and notify' }));
    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'evt_1', data: { attendees: [{ email: 'bob@acme.com', name: 'Bob' }] }, sendNotification: true },
      expect.any(Object),
    );
  });
});

describe('EventDetailPanel WeldMeet link (TASK-890)', () => {
  it('creates the meeting with the event times and guests and links it in the same update', async () => {
    renderPanel({ attendees: [{ email: 'bob@acme.com', name: 'Bob' }] });

    fireEvent.click(screen.getByRole('button', { name: 'Generate WeldMeet link' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Planning',
        scheduledStart: '2026-10-05T09:00:00.000Z',
        scheduledEnd: '2026-10-05T10:00:00.000Z',
        attendees: [{ email: 'bob@acme.com', name: 'Bob' }],
      }),
    );
    expect(updateMutateAsync).toHaveBeenCalledWith({
      id: 'evt_1',
      data: { meetingUrl: expect.stringContaining('abc-defg-hij'), isVirtual: true, weldMeetingId: 'mtg_1' },
    });
  });

  it('cancels the meeting again when the event cannot be updated', async () => {
    updateMutateAsync.mockRejectedValue(new Error('boom'));
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Generate WeldMeet link' }));

    await waitFor(() => expect(cancelMeeting).toHaveBeenCalledWith({ id: 'mtg_1' }));
    expect(toastMock.error).toHaveBeenCalled();
  });
});
