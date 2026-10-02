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
  useRescheduleCalendarEvent: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useCalendarEventsRange: () => ({ data: undefined }),
  useUserCalendars: () => ({ data: { data: [] } }),
}));
vi.mock('@/hooks/use-crm-tasks', () => ({
  useCreateTask: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMembers: () => ({ data: { data: [] } }),
  useWorkingHours: () => ({ data: undefined }),
}));
vi.mock('@/components/objects/person/use-person-data', () => ({
  usePeople: () => ({ data: [], people: [] }),
}));
vi.mock('./location-autocomplete', () => ({
  LocationAutocomplete: () => <input />,
}));

import { QuickCreateCard } from './calendar-view';

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
