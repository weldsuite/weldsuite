import { useAuth } from '@clerk/clerk-react';
import { useCancelMeeting, useCreateMeeting } from '@/hooks/queries/use-weldmeet-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { buildMeetingShareUrl } from '@/lib/weldmeet/share-link';
import { getTranslations } from '@/lib/i18n';
import type { CreateMeetingAttendee, CreateMeetingRequest } from '@/lib/api/domains/weldmeet';
import { toast } from 'sonner';

export interface WeldMeetSettings {
  accessType: 'workspace' | 'invited_only' | 'anyone_with_link';
  waitingRoom: boolean;
  allowRecording: boolean;
}

/** Settings a WeldMeet meeting starts with when the user did not touch the popover. */
export const DEFAULT_WELDMEET_SETTINGS: WeldMeetSettings = {
  accessType: 'anyone_with_link',
  waitingRoom: true,
  allowRecording: false,
};

export interface CreateWeldMeetingOptions extends Partial<WeldMeetSettings> {
  scheduledStart?: Date | string;
  scheduledEnd?: Date | string;
  attendees?: CreateMeetingAttendee[];
}

export interface WeldMeetDeps {
  createMeeting: (data: CreateMeetingRequest) => Promise<{ id: string; joinCode?: string | null }>;
  cancelMeeting: (id: string) => Promise<unknown>;
  /** Fallback for an API that does not return the join code on create. */
  fetchJoinCode: (id: string) => Promise<string | null>;
  workspaceId: string | null | undefined;
}

/** Thrown when the meeting could not be created. The user has already been told (toast). */
export class WeldMeetCreateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WeldMeetCreateError';
  }
}

const toIso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : value);

function errorDescription(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | null;
  return e?.response?.data?.error || e?.message || fallback;
}

/** Best-effort: a meeting we could not hand out must not stay in the meeting list. */
async function cancelQuietly(deps: WeldMeetDeps, meetingId: string): Promise<void> {
  try {
    await deps.cancelMeeting(meetingId);
  } catch {
    // The caller is already reporting the failure that got us here.
  }
}

/**
 * Creates the WeldMeet meeting and builds its share link. Shows an error toast
 * and throws `WeldMeetCreateError` when that is not possible.
 */
export async function provisionWeldMeeting(
  deps: WeldMeetDeps,
  title: string,
  options: CreateWeldMeetingOptions = {},
): Promise<{ url: string; meetingId: string }> {
  const t = getTranslations('weldmeet');
  const body: CreateMeetingRequest = {
    title: title || 'Meeting',
    meetingType: 'video',
    accessType: options.accessType ?? 'anyone_with_link',
    waitingRoom: options.waitingRoom ?? true,
  };
  if (options.allowRecording !== undefined) body.allowRecording = options.allowRecording;
  if (options.scheduledStart) body.scheduledStart = toIso(options.scheduledStart);
  if (options.scheduledEnd) body.scheduledEnd = toIso(options.scheduledEnd);
  if (options.attendees?.length) body.attendees = options.attendees;

  let created: { id: string; joinCode?: string | null };
  try {
    created = await deps.createMeeting(body);
  } catch (err) {
    toast.error(t.newMeetingPage.meetingCreateFailed, {
      description: errorDescription(err, t.newMeetingPage.meetingCreateFailedHint),
    });
    throw new WeldMeetCreateError('Failed to create WeldMeet meeting', { cause: err });
  }

  // The create response carries the join code; fall back to fetching the
  // meeting for an API that predates that.
  let code = created.joinCode ?? null;
  if (!code) {
    try {
      code = await deps.fetchJoinCode(created.id);
    } catch {
      code = null;
    }
  }
  const url = buildMeetingShareUrl(deps.workspaceId, code);
  if (!url) {
    // Never hand back a link that cannot work (e.g. ".../null").
    await cancelQuietly(deps, created.id);
    toast.error(t.newMeetingPage.meetingLinkUnavailable, {
      description: t.newMeetingPage.meetingLinkUnavailableHint,
    });
    throw new WeldMeetCreateError('WeldMeet meeting has no join link');
  }
  return { url, meetingId: created.id };
}

export interface SaveEventWithWeldMeetParams<R> {
  /** Final event title, used as the meeting title. */
  title: string;
  start: Date | string;
  end?: Date | string;
  attendees?: CreateMeetingAttendee[];
  settings?: Partial<WeldMeetSettings>;
  /** Creates / updates the calendar event with the meeting link and links the meeting to it. */
  saveEvent: (meetingUrl: string, weldMeetingId: string) => Promise<R>;
}

/**
 * Saves a calendar event that carries a new WeldMeet meeting: (1) create the
 * meeting with the event's schedule, guests and settings, (2) save the event
 * with the meeting link + `weldMeetingId` (the calendar API links both
 * atomically), (3) if the event cannot be saved, cancel the meeting again so no
 * orphan is left behind, and rethrow.
 */
export async function runSaveEventWithWeldMeet<R extends { weldMeetingLinked?: boolean } | void>(
  deps: WeldMeetDeps,
  params: SaveEventWithWeldMeetParams<R>,
): Promise<R> {
  const t = getTranslations('weldmeet');
  const meeting = await provisionWeldMeeting(deps, params.title, {
    ...params.settings,
    scheduledStart: params.start,
    scheduledEnd: params.end,
    attendees: params.attendees,
  });

  let result: R;
  try {
    result = await params.saveEvent(meeting.url, meeting.meetingId);
  } catch (err) {
    // Cancel (not delete): members may cancel their own meeting but not delete it.
    await cancelQuietly(deps, meeting.meetingId);
    throw err;
  }

  if (result && result.weldMeetingLinked === false) {
    toast.warning(t.newMeetingPage.meetingLinkFailed, {
      description: t.newMeetingPage.meetingLinkFailedHint,
    });
  }
  return result;
}

export function useAutoCreateWeldMeeting() {
  const { orgId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  const createMeeting = useCreateMeeting();
  const cancelMeeting = useCancelMeeting();
  const { getClient } = useAppApiClient();

  const deps: WeldMeetDeps = {
    createMeeting: (data) => createMeeting.mutateAsync(data),
    cancelMeeting: (id) => cancelMeeting.mutateAsync({ id }),
    fetchJoinCode: async (id) => {
      const client = await getClient();
      const res = await client.get<{ data: { joinCode: string | null } }>(`/meetings/${id}`);
      return res.data?.joinCode ?? null;
    },
    workspaceId,
  };

  /**
   * Creates a meeting right away and returns its share link, or `null` when it
   * failed (already reported). Used to add a link to an event that is already
   * saved; a new event goes through `saveEventWithWeldMeet` instead.
   */
  const createMeetingAndGetUrl = async (
    title?: string,
    options?: CreateWeldMeetingOptions,
  ): Promise<{ url: string; meetingId: string } | null> => {
    try {
      return await provisionWeldMeeting(deps, title || 'Meeting', options);
    } catch (err) {
      if (err instanceof WeldMeetCreateError) return null;
      throw err;
    }
  };

  const saveEventWithWeldMeet = <R extends { weldMeetingLinked?: boolean } | void>(
    params: SaveEventWithWeldMeetParams<R>,
  ): Promise<R> => runSaveEventWithWeldMeet(deps, params);

  return {
    createMeetingAndGetUrl,
    saveEventWithWeldMeet,
    isPending: createMeeting.isPending,
  };
}
