import { describe, it, expect, vi, beforeEach } from 'vitest';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import {
  provisionWeldMeeting,
  runSaveEventWithWeldMeet,
  WeldMeetCreateError,
  type WeldMeetDeps,
} from './use-auto-create-weld-meeting';

const calls: string[] = [];

function makeDeps(overrides: Partial<WeldMeetDeps> = {}): WeldMeetDeps & {
  createMeeting: ReturnType<typeof vi.fn>;
  cancelMeeting: ReturnType<typeof vi.fn>;
  fetchJoinCode: ReturnType<typeof vi.fn>;
} {
  return {
    workspaceId: 'org_123',
    createMeeting: vi.fn(async () => {
      calls.push('createMeeting');
      return { id: 'mtg_1', joinCode: 'abc-defg-hij' };
    }),
    cancelMeeting: vi.fn(async () => {
      calls.push('cancelMeeting');
    }),
    fetchJoinCode: vi.fn(async () => null),
    ...overrides,
  } as never;
}

const start = new Date('2026-10-05T09:00:00.000Z');
const end = new Date('2026-10-05T10:00:00.000Z');

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('runSaveEventWithWeldMeet', () => {
  it('creates the meeting with schedule, guests and settings, then saves the event with the link and meeting id', async () => {
    const deps = makeDeps();
    const saveEvent = vi.fn(async (_url: string, _meetingId: string) => {
      calls.push('saveEvent');
      return { weldMeetingLinked: true };
    });

    const result = await runSaveEventWithWeldMeet(deps, {
      title: 'Planning',
      start,
      end,
      attendees: [{ email: 'a@acme.com', name: 'Anna' }],
      settings: { accessType: 'invited_only', waitingRoom: false, allowRecording: false },
      saveEvent,
    });

    expect(calls).toEqual(['createMeeting', 'saveEvent']);
    expect(deps.createMeeting).toHaveBeenCalledWith({
      title: 'Planning',
      meetingType: 'video',
      accessType: 'invited_only',
      waitingRoom: false,
      allowRecording: false,
      scheduledStart: '2026-10-05T09:00:00.000Z',
      scheduledEnd: '2026-10-05T10:00:00.000Z',
      attendees: [{ email: 'a@acme.com', name: 'Anna' }],
    });
    const [url, meetingId] = saveEvent.mock.calls[0];
    expect(url).toContain('abc-defg-hij');
    expect(url).toContain('org_123');
    expect(meetingId).toBe('mtg_1');
    expect(result).toEqual({ weldMeetingLinked: true });
    expect(deps.cancelMeeting).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('cancels the meeting (never deletes it) and rethrows when the event cannot be saved', async () => {
    const deps = makeDeps();
    const failure = new Error('event save failed');
    const saveEvent = vi.fn(async () => {
      throw failure;
    });

    await expect(
      runSaveEventWithWeldMeet(deps, { title: 'Planning', start, end, saveEvent }),
    ).rejects.toBe(failure);

    expect(deps.cancelMeeting).toHaveBeenCalledTimes(1);
    expect(deps.cancelMeeting).toHaveBeenCalledWith('mtg_1');
  });

  it('still rethrows the original error when cancelling the meeting fails too', async () => {
    const deps = makeDeps({ cancelMeeting: vi.fn(async () => Promise.reject(new Error('cancel failed'))) });
    const failure = new Error('event save failed');

    await expect(
      runSaveEventWithWeldMeet(deps, {
        title: 'Planning',
        start,
        saveEvent: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it('warns when the event saved but the meeting could not be linked to it', async () => {
    const deps = makeDeps();

    const result = await runSaveEventWithWeldMeet(deps, {
      title: 'Planning',
      start,
      end,
      saveEvent: async () => ({ weldMeetingLinked: false }),
    });

    expect(result).toEqual({ weldMeetingLinked: false });
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(deps.cancelMeeting).not.toHaveBeenCalled();
  });

  it('does not save the event when the meeting cannot be created', async () => {
    const deps = makeDeps({ createMeeting: vi.fn(async () => Promise.reject(new Error('forbidden'))) });
    const saveEvent = vi.fn(async () => ({}));

    await expect(
      runSaveEventWithWeldMeet(deps, { title: 'Planning', start, end, saveEvent }),
    ).rejects.toBeInstanceOf(WeldMeetCreateError);

    expect(saveEvent).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });
});

describe('provisionWeldMeeting', () => {
  it('keeps the legacy defaults and omits the schedule and recording flag when none is given', async () => {
    const deps = makeDeps();

    const result = await provisionWeldMeeting(deps, 'Quick sync');

    expect(deps.createMeeting).toHaveBeenCalledWith({
      title: 'Quick sync',
      meetingType: 'video',
      accessType: 'anyone_with_link',
      waitingRoom: true,
    });
    expect(result).toEqual({ url: expect.stringContaining('abc-defg-hij'), meetingId: 'mtg_1' });
  });

  it('falls back to fetching the join code when the create response has none', async () => {
    const deps = makeDeps({
      createMeeting: vi.fn(async () => ({ id: 'mtg_2' })),
      fetchJoinCode: vi.fn(async () => 'zzz-yyyy-xxx'),
    });

    const result = await provisionWeldMeeting(deps, 'Quick sync');

    expect(deps.fetchJoinCode).toHaveBeenCalledWith('mtg_2');
    expect(result.url).toContain('zzz-yyyy-xxx');
  });

  it('cancels the meeting and throws when no working link can be built', async () => {
    const deps = makeDeps({ createMeeting: vi.fn(async () => ({ id: 'mtg_3', joinCode: null })) });

    await expect(provisionWeldMeeting(deps, 'Quick sync')).rejects.toBeInstanceOf(WeldMeetCreateError);

    expect(deps.cancelMeeting).toHaveBeenCalledWith('mtg_3');
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });
});
