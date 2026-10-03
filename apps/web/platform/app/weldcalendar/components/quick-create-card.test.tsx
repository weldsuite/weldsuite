import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
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
  useRescheduleCalendarEvent: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useCalendarEventsRange: () => ({ data: undefined }),
  useUserCalendars: () => ({ data: { data: [] } }),
}));
const createTask = vi.hoisted(() => vi.fn());
const peopleRows = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));
vi.mock('@/hooks/use-crm-tasks', () => ({
  useCreateTask: () => ({ mutateAsync: createTask, isPending: false }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMembers: () => ({ data: { data: [] } }),
  useWorkingHours: () => ({ data: undefined }),
  useUserPreferences: () => ({ data: undefined }),
}));
vi.mock('@/components/objects/person/use-person-data', () => ({
  usePeople: () => ({ data: { data: peopleRows.current }, people: [] }),
}));
vi.mock('./location-autocomplete', () => ({
  LocationAutocomplete: () => <input />,
}));

import { QuickCreateCard } from './calendar-view';
import { useDismissOnOutsideMouseDown } from './quick-create-dismiss';

const calendars = [{ id: 'cal_1', name: 'Work', isOwn: true, permission: 'manage' as const, ownerId: 'u1' }];

function renderCard(props: Partial<React.ComponentProps<typeof QuickCreateCard>> = {}) {
  const onClose = vi.fn();
  render(
    <QuickCreateCard
      defaultType="event"
      defaultTitle="Planning"
      defaultStart={new Date('2026-10-05T09:00:00.000Z')}
      defaultEnd={new Date('2026-10-05T10:00:00.000Z')}
      calendars={calendars}
      defaultCalendarId="cal_1"
      onClose={onClose}
      onMoreOptions={vi.fn()}
      {...props}
    />,
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  createMeeting.mockResolvedValue({ id: 'mtg_1', joinCode: 'abc-defg-hij' });
  cancelMeeting.mockResolvedValue(undefined);
  createEvent.mockResolvedValue({ data: { id: 'evt_1', weldMeetingLinked: true } });
  updateEvent.mockResolvedValue({ data: { id: 'evt_1', weldMeetingLinked: true } });
  createTask.mockResolvedValue({ success: true });
  peopleRows.current = [];
});

describe('QuickCreateCard WeldMeet', () => {
  it('makes no API call when WeldMeet is added and offers the settings but no copy button', () => {
    renderCard();

    fireEvent.click(screen.getByText('Add WeldMeet video conferencing'));

    expect(screen.getByText('Link is created when you save')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Meeting settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    expect(createMeeting).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('creates no meeting when the card is removed again before saving', async () => {
    renderCard();

    fireEvent.click(screen.getByText('Add WeldMeet video conferencing'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove WeldMeet' }));
    expect(screen.getByText('Add WeldMeet video conferencing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createMeeting).not.toHaveBeenCalled();
    expect(createEvent.mock.calls[0][0]).not.toHaveProperty('weldMeetingId');
  });

  it('creates the meeting on Save with the event times, then saves the event with the link', async () => {
    const { onClose } = renderCard();

    fireEvent.click(screen.getByText('Add WeldMeet video conferencing'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Planning',
        allowRecording: false,
        scheduledStart: expect.stringMatching(/^2026-10-05T/),
        scheduledEnd: expect.stringMatching(/^2026-10-05T/),
      }),
    );
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        isVirtual: true,
        weldMeetingId: 'mtg_1',
        meetingUrl: expect.stringContaining('abc-defg-hij'),
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('cancels the meeting and keeps the card open when the event cannot be saved', async () => {
    createEvent.mockRejectedValue(new Error('boom'));
    const { onClose } = renderCard();

    fireEvent.click(screen.getByText('Add WeldMeet video conferencing'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(cancelMeeting).toHaveBeenCalledWith({ id: 'mtg_1' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears the link of a saved event when it is removed in edit mode', async () => {
    renderCard({
      editEvent: {
        id: 'evt_1',
        calendarId: 'cal_1',
        type: 'event',
        title: 'Planning',
        startTime: '2026-10-05T09:00:00.000Z',
        endTime: '2026-10-05T10:00:00.000Z',
        isVirtual: true,
        meetingUrl: 'https://meet.weldsuite.org/org_123/abc-defg-hij',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove WeldMeet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    expect(updateEvent.mock.calls[0][0].data).toEqual(expect.objectContaining({ isVirtual: false, meetingUrl: '' }));
    expect(createMeeting).not.toHaveBeenCalled();
  });
});

describe('QuickCreateCard participants', () => {
  const openGuestSearch = () => {
    fireEvent.click(screen.getByText('Add participants'));
    return screen.getByPlaceholderText(/Search team members, contacts or type an email/);
  };

  it('does not save the event when Enter is pressed in the participants search', async () => {
    const { onClose } = renderCard();
    const input = openGuestSearch();

    fireEvent.change(input, { target: { value: 'nobody' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Give a (wrong) async save the chance to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(createEvent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers to invite a typed email and adds it as a guest chip on Enter, without saving', async () => {
    const { onClose } = renderCard();
    const input = openGuestSearch();

    fireEvent.change(input, { target: { value: 'jane@acme.com' } });
    expect(screen.getByText('Invite jane@acme.com')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('jane@acme.com')).toBeInTheDocument();
    expect(createEvent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0][0].attendees).toEqual([{ email: 'jane@acme.com', name: undefined }]);
  });

  it('adds the invited address on click too', () => {
    renderCard();
    const input = openGuestSearch();

    fireEvent.change(input, { target: { value: 'bob@acme.com' } });
    fireEvent.mouseDown(screen.getByText('Invite bob@acme.com'));

    expect(screen.getByText('bob@acme.com')).toBeInTheDocument();
  });

  it('does not offer an invite for text that is not an email', () => {
    renderCard();
    const input = openGuestSearch();

    fireEvent.change(input, { target: { value: 'jane@' } });

    expect(screen.queryByText(/^Invite /)).not.toBeInTheDocument();
  });

  it('lists contacts with an email and skips contacts without one', () => {
    peopleRows.current = [
      { id: 'p1', firstName: 'Ann', lastName: 'Has', fullName: 'Ann Has', email: 'ann@acme.com' },
      { id: 'p2', firstName: 'Nora', lastName: 'Mail', fullName: 'Nora Mail', email: null },
    ];
    renderCard();
    const input = openGuestSearch();

    fireEvent.change(input, { target: { value: 'a' } });

    expect(screen.getByText('Ann Has')).toBeInTheDocument();
    expect(screen.queryByText('Nora Mail')).not.toBeInTheDocument();
  });

  it('does not offer an invite for an address that is already listed', () => {
    peopleRows.current = [{ id: 'p1', firstName: 'Ann', lastName: 'Has', fullName: 'Ann Has', email: 'ann@acme.com' }];
    renderCard();
    const input = openGuestSearch();

    fireEvent.change(input, { target: { value: 'ann@acme.com' } });

    expect(screen.getByText('Ann Has')).toBeInTheDocument();
    expect(screen.queryByText('Invite ann@acme.com')).not.toBeInTheDocument();
  });

  it('picks the first listed person on Enter', () => {
    peopleRows.current = [{ id: 'p1', firstName: 'Ann', lastName: 'Has', fullName: 'Ann Has', email: 'ann@acme.com' }];
    renderCard();
    const input = openGuestSearch();

    fireEvent.change(input, { target: { value: 'ann' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('Ann Has')).toBeInTheDocument();
    expect(createEvent).not.toHaveBeenCalled();
  });
});

describe('QuickCreateCard repeat', () => {
  it('hides Repeat on the Event tab and shows it on the Task tab', () => {
    renderCard();

    expect(screen.queryByRole('button', { name: 'Repeat' })).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Task' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Task' }));

    expect(screen.getByRole('button', { name: 'Repeat' })).toBeInTheDocument();
  });
});

describe('QuickCreateCard times', () => {
  it('rolls an end at or before the start to the next day and sends the browser timezone', async () => {
    renderCard({
      defaultStart: new Date(2026, 9, 1, 23, 0),
      defaultEnd: new Date(2026, 9, 1, 0, 0),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    const payload = createEvent.mock.calls[0][0] as { startTime: string; endTime: string; timezone?: string };
    expect(new Date(payload.endTime).getTime()).toBe(new Date(2026, 9, 2, 0, 0).getTime());
    expect(new Date(payload.endTime).getTime()).toBeGreaterThan(new Date(payload.startTime).getTime());
    expect(payload.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('shows the quick-create times in the user clock format (12h by default)', () => {
    renderCard({ defaultStart: new Date(2026, 9, 5, 9, 0), defaultEnd: new Date(2026, 9, 5, 10, 0) });

    expect(screen.getByText('9:00 AM')).toBeInTheDocument();
    expect(screen.getByText('10:00 AM')).toBeInTheDocument();
  });
});

describe('QuickCreateCard task', () => {
  const renderTask = (props: Partial<React.ComponentProps<typeof QuickCreateCard>> = {}) =>
    renderCard({
      defaultType: 'reminder',
      defaultStart: new Date(2026, 9, 14, 9, 0),
      defaultEnd: new Date(2026, 9, 14, 10, 0),
      ...props,
    });

  it('pins the task to the clicked day and slot', async () => {
    const { onClose } = renderTask();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    const payload = createTask.mock.calls[0][0] as { dueDate: Date; startDate: Date; duration?: number };
    expect(payload.startDate).toEqual(new Date(2026, 9, 14, 9, 0));
    expect(payload.dueDate).toEqual(new Date(2026, 9, 14, 9, 0));
    expect(payload.duration).toBe(60);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows the due time in the user clock format instead of raw 24h', () => {
    renderTask();

    expect(screen.getByText('· 9:00 AM')).toBeInTheDocument();
  });

  it('stays open when the task could not be created', async () => {
    createTask.mockResolvedValue({ success: false, error: 'nope' });
    const { onClose } = renderTask();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('QuickCreateCard date picker', () => {
  function Harness({ onDismiss }: { onDismiss: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useDismissOnOutsideMouseDown(true, ref, onDismiss);
    return (
      <div>
        <button type="button">outside</button>
        <div ref={ref}>
          <QuickCreateCard
            defaultType="event"
            defaultTitle="Planning"
            defaultStart={new Date(2026, 9, 5, 9, 0)}
            defaultEnd={new Date(2026, 9, 5, 10, 0)}
            calendars={calendars}
            defaultCalendarId="cal_1"
            onClose={vi.fn()}
            onMoreOptions={vi.fn()}
          />
        </div>
      </div>
    );
  }

  it('keeps the card open when a day is picked in the popover, and saves the picked end date', async () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText(/Monday, Oct 5/));
    const pickers = screen.getAllByRole('button', { name: /Oct(ober)? 5|5 Oct/ });
    // The second date field is the end date.
    fireEvent.click(pickers[pickers.length - 1]!);
    const day = await screen.findByRole('button', { name: /October 7th/ });
    fireEvent.mouseDown(day);
    fireEvent.click(day);

    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(new Date(createEvent.mock.calls[0][0].endTime).getDate()).toBe(7);
  });

  it('still closes on a click outside the card', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
