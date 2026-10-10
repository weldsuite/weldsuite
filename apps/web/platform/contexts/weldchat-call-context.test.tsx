/**
 * WeldChat call context: what a RealtimeKit `roomLeft` does to the call.
 *
 * The SDK emits `roomLeft { state: 'disconnected' }` on a dropped connection
 * and then reconnects by itself. Treating that as a leave threw people out of
 * the call on a short network drop, and their /leave could end it for everyone.
 *
 * Also: a user is in at most one call, so an incoming call rings while busy
 * without touching the live one, and accepting it (or starting / joining
 * another) asks to switch through the active-call coordinator.
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
  self: {
    audioEnabled: true,
    videoEnabled: true,
  },
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

const sounds = vi.hoisted(() => ({
  playCallJoinSound: vi.fn(),
  playCallLeaveSound: vi.fn(),
  playIncomingRingSound: vi.fn(),
  playMuteSound: vi.fn(),
  playUnmuteSound: vi.fn(),
  playCameraToggleSound: vi.fn(),
  playScreenShareSound: vi.fn(),
  playHandRaiseSound: vi.fn(),
  playHandLowerSound: vi.fn(),
}));

vi.mock('@cloudflare/realtimekit', () => ({
  default: {
    init: vi.fn(async () => ({
      self: {
        // The ids the server may have stored for this connection.
        id: 'peer_me',
        userId: 'rtk_user_me',
        get audioEnabled() {
          return rtk.self.audioEnabled;
        },
        get videoEnabled() {
          return rtk.self.videoEnabled;
        },
        on: (event: string, handler: Handler) => {
          rtk.handlers.set(event, handler);
        },
        off: vi.fn(),
        enableAudio: vi.fn(async () => {
          rtk.self.audioEnabled = true;
        }),
        disableAudio: vi.fn(async () => {
          rtk.self.audioEnabled = false;
        }),
        enableVideo: vi.fn(async () => {
          rtk.self.videoEnabled = true;
        }),
        disableVideo: vi.fn(async () => {
          rtk.self.videoEnabled = false;
        }),
        disableScreenShare: vi.fn(async () => undefined),
      },
      join: vi.fn(async () => undefined),
      // Like the SDK: leaving emits roomLeft { state: 'left' }.
      leave: vi.fn(async () => {
        rtk.log.push('rtk:leave');
        rtk.handlers.get('roomLeft')?.({ state: 'left' });
      }),
    })),
  },
}));

vi.mock('@weldsuite/df3-noise-suppression', () => ({
  createRnnoiseSuppressor: () => ({ dispose: async () => undefined }),
  installGetUserMediaPatch: () => () => undefined,
}));
vi.mock('@weldsuite/df3-noise-suppression/rnnoise-worker?worker&url', () => ({ default: 'rnnoise-worker.js' }));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => api }),
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 'jwt_test' }),
  useUser: () => ({ user: { id: 'user_me' } }),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/i18n', () => ({
  getTranslations: () => ({
    calling: {
      reconnecting: 'Connection lost. Reconnecting…',
      reconnected: 'You are back in the call',
      connectionLost: "Couldn't reconnect to the call. Call again to continue.",
      supersededByOtherCall: 'You left this call because you joined another call or meeting.',
    },
    switchCallDialog: {
      currentCall: 'your current call',
      newCall: 'the new call',
      callInChannel: 'the call in {name}',
      callWithPerson: 'the call with {name}',
      callFromPerson: 'the call from {name}',
      currentMeeting: 'your current meeting',
      newMeeting: 'a new meeting',
      meetingNamed: 'the meeting "{title}"',
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  weldchatKeys: {
    activeCall: (channelId: string) => ['weldchat', 'active-call', channelId],
    channelDetail: (channelId: string) => ['weldchat', 'channels', channelId],
    members: (channelId: string) => ['weldchat', 'members', channelId],
  },
}));
vi.mock('@/lib/utils/notification-sound', () => sounds);
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
vi.mock('@weldsuite/realtime/client', () => ({
  RoomClient: class {
    on() {
      return () => undefined;
    }
    connect() {
      return Promise.resolve();
    }
    disconnect() {}
    sendHandRaise() {}
    sendHandLower() {}
  },
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
vi.mock('@/contexts/presence-context', () => ({ usePresenceMaybe: () => null }));
vi.mock('@/lib/api/public-env', () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  getRealtimeWsOrigin: () => 'wss://realtime.test',
}));

import { WeldChatCallProvider, useWeldChatCall } from './weldchat-call-context';
import { ActiveCallProvider, useCallSwitchDialog, useRegisterActiveCall } from './active-call-context';

const RECONNECT_TOAST = 'weldchat-reconnecting';

let call: ReturnType<typeof useWeldChatCall>;
function Probe() {
  call = useWeldChatCall();
  return null;
}

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));

/** Fire an event the SDK emits on `meeting.self`. */
function emit(event: string, payload?: Record<string, unknown>) {
  const handler = rtk.handlers.get(event);
  if (!handler) throw new Error(`no ${event} handler registered`);
  act(() => handler(payload));
}

/** The keepalive /leave the context fires when the room is left under it. */
const leaveBeacons = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/chat-calls/call_1/leave'));

/** Publish an event on the user's personal topic, as the realtime worker would. */
function publish(event: string, data: Record<string, unknown>) {
  const topic = 'chat.user.user_me';
  act(() => {
    for (const subscriber of realtime.subscribers) {
      if (subscriber.topic === topic) subscriber.handler({ topic, event, data, ts: 0, userId: 'user_me' });
    }
  });
}

const incomingCall = (callId: string) => ({
  callId,
  channelId: 'ch_2',
  callType: 'voice' as const,
  callerName: 'Alice',
});

let switchDialog: ReturnType<typeof useCallSwitchDialog>;
function DialogProbe() {
  switchDialog = useCallSwitchDialog();
  return null;
}

/** A live WeldMeet meeting, as the meet provider registers it. */
function FakeMeeting({ leave }: Readonly<{ leave: () => Promise<void> }>) {
  useRegisterActiveCall('meet', { id: 'mtg_1', label: 'the meeting "Standup"', leave });
  return null;
}

interface MountOptions {
  /** Mount under the active-call coordinator (the app shell does). */
  coordinator?: boolean;
  /** A WeldMeet meeting that is live, with the leave the meet provider would register. */
  meetingLeave?: () => Promise<void>;
}

/** Mount the provider alone, or under the coordinator like the app shell does. */
function mountChat({ coordinator = false, meetingLeave }: MountOptions = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      {coordinator ? (
        <ActiveCallProvider>
          <DialogProbe />
          {meetingLeave ? <FakeMeeting leave={meetingLeave} /> : null}
          <WeldChatCallProvider>{children}</WeldChatCallProvider>
        </ActiveCallProvider>
      ) : (
        <WeldChatCallProvider>{children}</WeldChatCallProvider>
      )}
    </QueryClientProvider>
  );
  render(<Probe />, { wrapper });
}

/** Mount the provider and get into a connected call (`call_1` in `ch_1`). */
async function startConnectedCall(options: MountOptions = {}) {
  mountChat(options);
  await act(async () => {
    await call.startCall('ch_1', 'video');
  });
  emit('roomJoined', {});
  await waitFor(() => expect(call.status).toBe('connected'));
  // Let the token refresh land, so a leave beacon would be able to go out.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  realtime.subscribers.clear();
  rtk.handlers.clear();
  rtk.log.length = 0;
  rtk.self.audioEnabled = true;
  rtk.self.videoEnabled = true;
  vi.clearAllMocks();
  api.post.mockImplementation(async (path: string) => {
    rtk.log.push(`api:${path}`);
    return { data: { callId: 'call_1', authToken: 'tok_1', participants: [], callType: 'video' } };
  });
  api.get.mockImplementation(async (path: string) => ({
    data: { id: path.split('/').pop(), channelId: 'ch_2', callType: 'voice' },
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WeldChatCallProvider · a dropped connection', () => {
  it('keeps the call and shows a reconnecting toast on roomLeft "disconnected"', async () => {
    await startConnectedCall();

    emit('roomLeft', { state: 'disconnected' });

    expect(call.status).toBe('connected');
    expect(call.callId).toBe('call_1');
    expect(call.meeting).not.toBeNull();
    expect(leaveBeacons()).toHaveLength(0);
    expect(api.post).not.toHaveBeenCalledWith('/chat-calls/call_1/leave', expect.anything());
    expect(toast.loading).toHaveBeenCalledWith(
      'Connection lost. Reconnecting…',
      expect.objectContaining({ id: RECONNECT_TOAST }),
    );
  });

  it('replaces the toast when the SDK is back, without a second join chime', async () => {
    await startConnectedCall();
    emit('roomLeft', { state: 'disconnected' });

    emit('roomJoined', { reconnected: true });

    expect(call.status).toBe('connected');
    expect(toast.success).toHaveBeenCalledWith(
      'You are back in the call',
      expect.objectContaining({ id: RECONNECT_TOAST }),
    );
    expect(sounds.playCallJoinSound).toHaveBeenCalledTimes(1);
  });

  it('tears the call down and tells the backend when the SDK gives up ("failed")', async () => {
    await startConnectedCall();
    emit('roomLeft', { state: 'disconnected' });

    emit('roomLeft', { state: 'failed' });

    expect(call.status).toBe('idle');
    expect(call.callId).toBeNull();
    expect(leaveBeacons()).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith("Couldn't reconnect to the call. Call again to continue.");
    expect(toast.dismiss).toHaveBeenCalledWith(RECONNECT_TOAST);
  });

  it.each(['ended', 'kicked'])('tears the call down on roomLeft "%s" without an error toast', async (state) => {
    await startConnectedCall();

    emit('roomLeft', { state });

    expect(call.status).toBe('idle');
    expect(call.meeting).toBeNull();
    expect(leaveBeacons()).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('WeldChatCallProvider · leaving on purpose', () => {
  it('leaves the RealtimeKit room before telling the backend, and reports the leave once', async () => {
    await startConnectedCall();
    rtk.log.length = 0;

    await act(async () => {
      await call.leaveCall();
    });

    // The backend ends the call only once RealtimeKit reports the room empty.
    expect(rtk.log.slice(0, 2)).toEqual(['rtk:leave', 'api:/chat-calls/call_1/leave']);
    expect(rtk.log.filter((entry) => entry === 'api:/chat-calls/call_1/leave')).toHaveLength(1);
    expect(leaveBeacons()).toHaveLength(0);
    expect(call.status).toBe('idle');
    expect(call.callId).toBeNull();
  });

  it('ends the call for everyone through /end', async () => {
    await startConnectedCall();

    await act(async () => {
      await call.endCall();
    });

    expect(api.post).toHaveBeenCalledWith('/chat-calls/call_1/end', {});
    expect(leaveBeacons()).toHaveLength(0);
    expect(call.status).toBe('idle');
  });
});

describe('WeldChatCallProvider · in-call toggles', () => {
  it('mutes and unmutes the microphone', async () => {
    await startConnectedCall();

    act(() => call.toggleMute());
    expect(call.isMuted).toBe(true);
    expect(sounds.playMuteSound).toHaveBeenCalledTimes(1);

    act(() => call.toggleMute());
    expect(call.isMuted).toBe(false);
    expect(sounds.playUnmuteSound).toHaveBeenCalledTimes(1);
  });

  it('turns the camera off and on', async () => {
    await startConnectedCall();

    act(() => call.toggleVideo());
    expect(call.isVideoOff).toBe(true);

    act(() => call.toggleVideo());
    expect(call.isVideoOff).toBe(false);
  });

  it('stops a screen share', async () => {
    await startConnectedCall();

    act(() => call.stopScreenShare());

    expect(call.isScreenSharing).toBe(false);
    expect(sounds.playScreenShareSound).toHaveBeenCalledTimes(1);
  });
});

describe('WeldChatCallProvider · an incoming call', () => {
  it('rings as before when the user is idle', () => {
    mountChat();

    publish('call_incoming', incomingCall('call_2'));

    expect(call.incomingCall).toMatchObject(incomingCall('call_2'));
    expect(call.status).toBe('ringing-incoming');
  });

  it('still rings during a call, as the toast only: the live call is untouched', async () => {
    await startConnectedCall();

    publish('call_incoming', incomingCall('call_2'));

    expect(call.incomingCall).toMatchObject(incomingCall('call_2'));
    expect(call.status).toBe('connected');
    expect(call.callId).toBe('call_1');
    expect(call.meeting).not.toBeNull();
    // The ringtone only plays for an idle user, never over the live call.
    expect(sounds.playIncomingRingSound).not.toHaveBeenCalled();
  });

  it('does not ring for the call the user is already in', async () => {
    await startConnectedCall();

    publish('call_incoming', incomingCall('call_1'));

    expect(call.incomingCall).toBeNull();
  });

  it('declining during a call ends only the ring', async () => {
    await startConnectedCall();
    publish('call_incoming', incomingCall('call_2'));

    await act(async () => {
      await call.declineCall();
    });

    expect(api.post).toHaveBeenCalledWith('/chat-calls/call_2/decline', {});
    expect(call.incomingCall).toBeNull();
    expect(call.status).toBe('connected');
  });

  it('goes back to idle when an idle user declines', async () => {
    mountChat();
    publish('call_incoming', incomingCall('call_2'));

    await act(async () => {
      await call.declineCall();
    });

    expect(call.incomingCall).toBeNull();
    expect(call.status).toBe('idle');
  });

  it('keeps ringing after the live call ends', async () => {
    await startConnectedCall();
    publish('call_incoming', incomingCall('call_2'));

    await act(async () => {
      await call.leaveCall();
    });

    expect(call.status).toBe('idle');
    expect(call.incomingCall).toMatchObject(incomingCall('call_2'));
  });
});

describe('WeldChatCallProvider · only one call at a time', () => {
  it('accepts right away when nothing else is live', async () => {
    mountChat({ coordinator: true });
    publish('call_incoming', incomingCall('call_2'));

    await act(async () => {
      await call.acceptIncomingCall();
    });

    expect(switchDialog?.dialog).toBeNull();
    expect(api.post).toHaveBeenCalledWith('/chat-calls/call_2/join', {});
    expect(call.callId).toBe('call_2');
    expect(call.incomingCall).toBeNull();
  });

  it('asks before accepting during a call, and leaves (not ends) that call when confirmed', async () => {
    await startConnectedCall({ coordinator: true });
    publish('call_incoming', incomingCall('call_2'));
    rtk.log.length = 0;
    api.get.mockClear();

    await act(async () => {
      void call.acceptIncomingCall();
    });

    expect(switchDialog?.dialog).toEqual({
      target: { kind: 'chat', label: 'the call from Alice' },
      current: 'your current call',
      switching: false,
    });
    // Nothing happened yet: still in call_1, and the ring is still up.
    expect(api.get).not.toHaveBeenCalled();
    expect(call.callId).toBe('call_1');
    expect(call.incomingCall).toMatchObject(incomingCall('call_2'));

    await act(async () => {
      await switchDialog?.confirm();
    });
    await waitFor(() => expect(call.callId).toBe('call_2'));

    expect(switchDialog?.dialog).toBeNull();
    expect(call.incomingCall).toBeNull();
    expect(rtk.log.filter((entry) => entry === 'api:/chat-calls/call_1/leave')).toHaveLength(1);
    expect(api.post).not.toHaveBeenCalledWith('/chat-calls/call_1/end', expect.anything());
    // Left call_1 first, then joined call_2.
    expect(rtk.log.indexOf('api:/chat-calls/call_1/leave')).toBeLessThan(rtk.log.indexOf('api:/chat-calls/call_2/join'));
    emit('roomJoined', {});
    await waitFor(() => expect(call.status).toBe('connected'));
  });

  it('stays in the call, and the ring stays up, when the user picks "Stay"', async () => {
    await startConnectedCall({ coordinator: true });
    publish('call_incoming', incomingCall('call_2'));
    await act(async () => {
      void call.acceptIncomingCall();
    });

    act(() => switchDialog?.dismiss());

    expect(switchDialog?.dialog).toBeNull();
    expect(call.callId).toBe('call_1');
    expect(call.status).toBe('connected');
    expect(call.incomingCall).toMatchObject(incomingCall('call_2'));
    expect(api.post).not.toHaveBeenCalledWith('/chat-calls/call_2/join', {});
  });

  it('asks before accepting during a WeldMeet meeting, and leaves the meeting when confirmed', async () => {
    const leaveMeeting = vi.fn(async () => undefined);
    mountChat({ coordinator: true, meetingLeave: leaveMeeting });
    publish('call_incoming', incomingCall('call_2'));
    // The meeting does not stop it from ringing.
    expect(call.status).toBe('ringing-incoming');

    await act(async () => {
      void call.acceptIncomingCall();
    });
    expect(switchDialog?.dialog?.current).toBe('the meeting "Standup"');
    expect(leaveMeeting).not.toHaveBeenCalled();

    await act(async () => {
      await switchDialog?.confirm();
    });
    await waitFor(() => expect(call.callId).toBe('call_2'));

    expect(leaveMeeting).toHaveBeenCalledTimes(1);
  });

  it('asks before starting a call during a meeting, and starts it once the meeting is left', async () => {
    const leaveMeeting = vi.fn(async () => undefined);
    mountChat({ coordinator: true, meetingLeave: leaveMeeting });

    await act(async () => {
      void call.startCall('ch_1', 'voice');
    });
    expect(api.post).not.toHaveBeenCalled();
    expect(switchDialog?.dialog?.target.kind).toBe('chat');

    await act(async () => {
      await switchDialog?.confirm();
    });
    await waitFor(() => expect(call.callId).toBe('call_1'));

    expect(leaveMeeting).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/chat-calls/start-and-join', { channelId: 'ch_1', callType: 'voice' });
  });

  it("asks before joining another channel's call during a call", async () => {
    await startConnectedCall({ coordinator: true });
    api.get.mockClear();

    await act(async () => {
      void call.joinCall('call_7');
    });

    expect(switchDialog?.dialog).not.toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    expect(call.callId).toBe('call_1');
  });

  it('does nothing when asked to join the call it is already in', async () => {
    await startConnectedCall({ coordinator: true });
    api.get.mockClear();
    api.post.mockClear();

    await act(async () => {
      await call.joinCall('call_1');
    });

    expect(switchDialog?.dialog).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('can switch away from a call that is still connecting', async () => {
    let finishStart: (value: unknown) => void = () => undefined;
    mountChat({ coordinator: true });
    // The start-and-join request is still in flight.
    api.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    await act(async () => {
      void call.startCall('ch_1', 'voice');
    });
    expect(call.status).toBe('connecting');
    await act(async () => {
      void call.startCall('ch_3', 'voice');
    });
    expect(switchDialog?.dialog).not.toBeNull();

    // Confirming waits for the first call to get a call id and a room, and leaves that.
    let confirming: Promise<void> | undefined;
    await act(async () => {
      confirming = switchDialog?.confirm();
    });
    await act(async () => {
      finishStart({ data: { callId: 'call_1', authToken: 'tok_1' } });
      await Promise.resolve();
    });
    emit('roomJoined', {});
    await act(async () => {
      await confirming;
    });

    expect(api.post).toHaveBeenCalledWith('/chat-calls/call_1/leave', {});
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/chat-calls/start-and-join', { channelId: 'ch_3', callType: 'voice' }),
    );
  });
});

describe('WeldChatCallProvider · dropped for another call', () => {
  const SUPERSEDED = 'You left this call because you joined another call or meeting.';

  it('explains the kick when the server said it was for another call', async () => {
    await startConnectedCall();
    publish('call_superseded', { kind: 'chat', id: 'call_1', cfSessionId: 'rtk_user_me' });

    emit('roomLeft', { state: 'kicked' });

    expect(toast.info).toHaveBeenCalledWith(SUPERSEDED);
    expect(call.status).toBe('idle');
  });

  it('explains it too when the event lands just after the kick', async () => {
    await startConnectedCall();

    emit('roomLeft', { state: 'kicked' });
    publish('call_superseded', { kind: 'chat', id: 'call_1', cfSessionId: 'peer_me' });

    expect(toast.info).toHaveBeenCalledWith(SUPERSEDED);
  });

  it('matches on the call id when the event carries no participant id', async () => {
    await startConnectedCall();
    publish('call_superseded', { kind: 'chat', id: 'call_1', cfSessionId: null });

    emit('roomLeft', { state: 'kicked' });

    expect(toast.info).toHaveBeenCalledWith(SUPERSEDED);
  });

  it('says nothing when a kick has no such event', async () => {
    await startConnectedCall();

    emit('roomLeft', { state: 'kicked' });

    expect(toast.info).not.toHaveBeenCalled();
  });

  it('ignores an event about another call, a meeting, or another tab of the same call', async () => {
    await startConnectedCall();
    publish('call_superseded', { kind: 'chat', id: 'call_9', cfSessionId: null });
    publish('call_superseded', { kind: 'meet', id: 'call_1', cfSessionId: null });
    // The older tab of the same call was evicted: this one stays, and would not be kicked.
    publish('call_superseded', { kind: 'chat', id: 'call_1', cfSessionId: 'peer_other_tab' });

    emit('roomLeft', { state: 'kicked' });

    expect(toast.info).not.toHaveBeenCalled();
  });
});

describe('WeldChatCallProvider · the incoming call ringtone', () => {
  /** Mount the provider idle and deliver a `call_incoming` event on the user topic. */
  function ringIncoming() {
    mountChat();
    publish('call_incoming', { callId: 'call_9', channelId: 'ch_9', callType: 'voice', callerName: 'Sam' });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rings on a loop while the popup is up, and goes quiet after 30s', () => {
    vi.useFakeTimers();
    ringIncoming();
    expect(call.status).toBe('ringing-incoming');
    expect(sounds.playIncomingRingSound).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(2600 * 2));
    expect(sounds.playIncomingRingSound).toHaveBeenCalledTimes(3);

    act(() => vi.advanceTimersByTime(60_000));
    const ringsAt30s = sounds.playIncomingRingSound.mock.calls.length;
    act(() => vi.advanceTimersByTime(60_000));
    expect(sounds.playIncomingRingSound).toHaveBeenCalledTimes(ringsAt30s);
    expect(call.status).toBe('ringing-incoming');
  });

  it('stops ringing as soon as the call is declined', async () => {
    vi.useFakeTimers();
    ringIncoming();
    await act(async () => {
      await call.declineCall();
    });
    expect(call.status).toBe('idle');

    act(() => vi.advanceTimersByTime(10_000));
    expect(sounds.playIncomingRingSound).toHaveBeenCalledTimes(1);
  });
});
