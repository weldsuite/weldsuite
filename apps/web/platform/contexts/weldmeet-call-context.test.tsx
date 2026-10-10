/**
 * WeldMeet call context and the one-call-at-a-time rule: the live meeting is
 * registered with the coordinator (so another call can ask to leave it), and a
 * kick caused by joining elsewhere is explained instead of being reported as
 * "the host ended the meeting".
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Handler = (payload?: Record<string, unknown>) => void;

const rtk = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: Record<string, unknown>) => void>(),
  /** What happened, in order: RealtimeKit leaves and backend calls. */
  log: [] as string[],
  /** Holds RealtimeKit's init() open, to keep a meeting "connecting". */
  initGate: null as Promise<void> | null,
}));

const api = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}));

/** Realtime topic subscriptions made through `useTopic`. */
const realtime = vi.hoisted(() => ({
  subscribers: new Set<{ topic: string; handler: (event: unknown) => void }>(),
}));

vi.mock('@cloudflare/realtimekit', () => ({
  default: {
    initMedia: vi.fn(async () => ({})),
    init: vi.fn(async () => {
      if (rtk.initGate) await rtk.initGate;
      return {
        self: {
          id: 'peer_me',
          userId: 'rtk_user_me',
          audioEnabled: true,
          videoEnabled: true,
          mediaPermissions: {},
          on: (event: string, handler: Handler) => {
            rtk.handlers.set(event, handler);
          },
          off: vi.fn(),
        },
        participants: { on: vi.fn(), off: vi.fn() },
        join: vi.fn(async () => undefined),
        // Like the SDK: leaving emits roomLeft { state: 'left' }.
        leave: vi.fn(async () => {
          rtk.log.push('rtk:leave');
          rtk.handlers.get('roomLeft')?.({ state: 'left' });
        }),
      };
    }),
  },
}));

vi.mock('@weldsuite/df3-noise-suppression', () => ({
  createRnnoiseSuppressor: () => ({ dispose: async () => undefined }),
  installGetUserMediaPatch: () => () => undefined,
}));
vi.mock('@weldsuite/df3-noise-suppression/rnnoise-worker?worker&url', () => ({ default: 'rnnoise-worker.js' }));
vi.mock('@weldsuite/weldmeet-ui', () => ({
  enableMicrophone: vi.fn(async () => ({ enabled: true, blocked: false })),
  isMicrophonePermissionDenied: vi.fn(async () => false),
  useLeaveCallGuard: () => undefined,
  useMicrophoneRecovery: () => undefined,
}));
vi.mock('@weldsuite/app-api-client/domains/weldmeet-recordings', () => ({
  createWeldmeetRecordingsApi: () => ({ setAiOptions: vi.fn() }),
}));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => api }),
}));
vi.mock('@/lib/api/public-env', () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
}));
vi.mock('@/lib/router', () => ({ usePathname: () => '/weldmeet/mtg_1/room' }));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 'jwt_test', userId: 'user_me' }),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/i18n', () => ({
  getTranslations: (namespace: string) =>
    namespace === 'weldmeet'
      ? {
          inCall: {
            connection: {
              reconnecting: 'Connection lost. Reconnecting…',
              reconnected: 'You are back in the meeting',
              lost: "Couldn't reconnect to the meeting.",
              supersededByOtherCall: 'You left this call because you joined another call or meeting.',
            },
            recording: {},
          },
          leaveMenu: { hostEnded: 'The host ended the meeting', endFailed: "Couldn't end the meeting for everyone" },
        }
      : {
          switchCallDialog: {
            currentCall: 'your current call',
            newCall: 'the new call',
            currentMeeting: 'your current meeting',
            newMeeting: 'a new meeting',
            meetingNamed: 'the meeting "{title}"',
          },
        },
}));
vi.mock('@/hooks/queries/use-weldmeet-queries', () => ({
  weldmeetKeys: {
    meeting: (id: string) => ['weldmeet', 'meeting', id],
    session: (id: string) => ['weldmeet', 'session', id],
  },
}));
vi.mock('@/lib/utils/notification-sound', () => ({
  playCallJoinSound: vi.fn(),
  playCallLeaveSound: vi.fn(),
  playMuteSound: vi.fn(),
  playUnmuteSound: vi.fn(),
  playCameraToggleSound: vi.fn(),
  playScreenShareSound: vi.fn(),
  playHandRaiseSound: vi.fn(),
  playHandLowerSound: vi.fn(),
}));
vi.mock('@/hooks/use-virtual-background', () => ({
  useVirtualBackground: () => ({
    backgroundType: 'none',
    backgroundValue: null,
    isLoading: false,
    applyBlur: vi.fn(),
    applyImage: vi.fn(),
    removeBackground: vi.fn(),
  }),
}));
vi.mock('@weldsuite/realtime/react', async () => {
  const React = await import('react');
  return {
    useTopic: (topic: string, handler: (event: unknown) => void) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      React.useEffect(() => {
        const subscriber = { topic, handler: (event: unknown) => latest.current(event) };
        realtime.subscribers.add(subscriber);
        return () => {
          realtime.subscribers.delete(subscriber);
        };
      }, [topic]);
    },
  };
});

import { WeldMeetCallProvider, useWeldMeetCall } from './weldmeet-call-context';
import { ActiveCallProvider, useCallSwitchDialog, useCallSwitchOptional } from './active-call-context';
import { setStartHandoff } from '@/lib/weldmeet/start-handoff';

const SUPERSEDED = 'You left this call because you joined another call or meeting.';
const HOST_ENDED = 'The host ended the meeting';

let meetCall: ReturnType<typeof useWeldMeetCall>;
let switchApi: ReturnType<typeof useCallSwitchOptional>;
let switchDialog: ReturnType<typeof useCallSwitchDialog>;
function Probe() {
  meetCall = useWeldMeetCall();
  switchApi = useCallSwitchOptional();
  switchDialog = useCallSwitchDialog();
  return null;
}

/** Fire an event the SDK emits on `meeting.self`. */
function emit(event: string, payload?: Record<string, unknown>) {
  const handler = rtk.handlers.get(event);
  if (!handler) throw new Error(`no ${event} handler registered`);
  act(() => handler(payload));
}

/** Publish an event on the user's personal topic, as the realtime worker would. */
function publish(event: string, data: Record<string, unknown>) {
  const topic = 'chat.user.user_me';
  act(() => {
    for (const subscriber of realtime.subscribers) {
      if (subscriber.topic === topic) subscriber.handler({ topic, event, data, ts: 0, userId: 'user_me' });
    }
  });
}

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <ActiveCallProvider>
        <WeldMeetCallProvider>{children}</WeldMeetCallProvider>
      </ActiveCallProvider>
    </QueryClientProvider>
  );
  render(<Probe />, { wrapper });
}

/**
 * Start joining meeting `mtg_1` (session `ses_1`) without the pre-join screen.
 * Resolves once the join has been started, not finished: with RealtimeKit held
 * open the join does not finish until the test lets it.
 */
async function joinMeeting() {
  setStartHandoff({ meetingId: 'mtg_1', sessionId: 'ses_1', authToken: 'tok_1', rtkMeetingId: 'rtk_1' });
  await act(async () => {
    void meetCall.joinMeeting('mtg_1', { skipPreview: true, title: 'Standup', meetingType: 'video' });
    await Promise.resolve();
  });
}

/** Get into a connected meeting. */
async function connectToMeeting() {
  mount();
  await joinMeeting();
  emit('roomJoined', {});
  await waitFor(() => expect(meetCall.status).toBe('connected'));
  await waitFor(() => expect(meetCall.meeting).not.toBeNull());
}

beforeEach(() => {
  // jsdom has no MediaStream; the pre-join preview builds one.
  vi.stubGlobal(
    'MediaStream',
    class {
      addTrack() {}
      getTracks() {
        return [];
      }
      getAudioTracks() {
        return [];
      }
      getVideoTracks() {
        return [];
      }
    },
  );
  rtk.handlers.clear();
  rtk.log.length = 0;
  rtk.initGate = null;
  realtime.subscribers.clear();
  vi.clearAllMocks();
  api.post.mockImplementation(async (path: string) => {
    rtk.log.push(`api:${path}`);
    return { data: {} };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WeldMeetCallProvider · one call at a time', () => {
  it('is registered while connected: another call asks, naming the meeting', async () => {
    await connectToMeeting();

    act(() => {
      switchApi.requestSwitch({ target: { kind: 'chat', label: 'the call with Alice' }, proceed: vi.fn() });
    });

    expect(switchDialog?.dialog).toEqual({
      target: { kind: 'chat', label: 'the call with Alice' },
      current: 'the meeting "Standup"',
      switching: false,
    });
  });

  it('leaves (never ends) the meeting on confirm, then lets the other call start', async () => {
    await connectToMeeting();
    rtk.log.length = 0;
    const proceed = vi.fn(() => {
      rtk.log.push('proceed');
    });
    act(() => {
      switchApi.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed });
    });

    await act(async () => {
      await switchDialog?.confirm();
    });

    expect(rtk.log).toContain('api:/meeting-sessions/ses_1/leave');
    expect(rtk.log).not.toContain('api:/meeting-sessions/ses_1/end');
    expect(rtk.log.indexOf('api:/meeting-sessions/ses_1/leave')).toBeLessThan(rtk.log.indexOf('proceed'));
    expect(meetCall.status).toBe('idle');
  });

  it('is not registered during the pre-join preview: nothing to leave yet', async () => {
    mount();
    await act(async () => {
      await meetCall.joinMeeting('mtg_1', { title: 'Standup' });
    });
    expect(meetCall.status).toBe('preview');
    const proceed = vi.fn();

    act(() => {
      switchApi.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed });
    });

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(switchDialog?.dialog).toBeNull();
  });

  it('can be left while it is still connecting: the leave waits for the room', async () => {
    let openGate: () => void = () => undefined;
    rtk.initGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    mount();
    await joinMeeting();
    expect(meetCall.status).toBe('connecting');
    act(() => {
      switchApi.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed: vi.fn() });
    });
    expect(switchDialog?.dialog).not.toBeNull();

    let confirming: Promise<void> | undefined;
    await act(async () => {
      confirming = switchDialog?.confirm();
    });
    // Still waiting for the room: no leave went out yet.
    expect(rtk.log).not.toContain('api:/meeting-sessions/ses_1/leave');

    await act(async () => {
      openGate();
      await Promise.resolve();
    });
    emit('roomJoined', {});
    await act(async () => {
      await confirming;
    });

    expect(rtk.log).toContain('api:/meeting-sessions/ses_1/leave');
    expect(meetCall.status).toBe('idle');
  });
});

describe('WeldMeetCallProvider · being dropped', () => {
  it('explains a kick that the server announced as "joined another call"', async () => {
    await connectToMeeting();
    publish('call_superseded', { kind: 'meet', id: 'ses_1', meetingId: 'mtg_1', cfSessionId: 'rtk_user_me' });

    emit('roomLeft', { state: 'kicked' });

    expect(toast.info).toHaveBeenCalledWith(SUPERSEDED);
    expect(toast.info).not.toHaveBeenCalledWith(HOST_ENDED);
    expect(meetCall.status).toBe('idle');
  });

  it('still says the host ended the meeting for a kick nothing explains, after a short wait', async () => {
    await connectToMeeting();
    vi.useFakeTimers();

    emit('roomLeft', { state: 'kicked' });
    // The explanation may still be on its way, so the generic message waits.
    expect(toast.info).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(toast.info).toHaveBeenCalledWith(HOST_ENDED);
  });

  it('prefers the explanation when it lands just after the kick', async () => {
    await connectToMeeting();
    vi.useFakeTimers();

    emit('roomLeft', { state: 'kicked' });
    publish('call_superseded', { kind: 'meet', id: 'ses_1', cfSessionId: 'peer_me' });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(SUPERSEDED);
  });

  it('is not the evicted tab when the event names another participant of the same meeting', async () => {
    await connectToMeeting();
    vi.useFakeTimers();
    publish('call_superseded', { kind: 'meet', id: 'ses_1', cfSessionId: 'peer_in_the_other_tab' });

    emit('roomLeft', { state: 'kicked' });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(toast.info).toHaveBeenCalledWith(HOST_ENDED);
    expect(toast.info).not.toHaveBeenCalledWith(SUPERSEDED);
  });

  it('does not treat leaving on purpose as being dropped', async () => {
    await connectToMeeting();

    await act(async () => {
      await meetCall.leaveMeeting();
    });

    expect(toast.info).not.toHaveBeenCalled();
  });
});
