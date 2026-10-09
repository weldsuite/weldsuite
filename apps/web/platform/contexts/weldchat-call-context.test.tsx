/**
 * WeldChat call context: what a RealtimeKit `roomLeft` does to the call.
 *
 * The SDK emits `roomLeft { state: 'disconnected' }` on a dropped connection
 * and then reconnects by itself. Treating that as a leave threw people out of
 * the call on a short network drop, and their /leave could end it for everyone.
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
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  weldchatKeys: { activeCall: (channelId: string) => ['weldchat', 'active-call', channelId] },
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
vi.mock('@weldsuite/realtime/react', () => ({ useTopic: vi.fn() }));
vi.mock('@/contexts/presence-context', () => ({ usePresenceMaybe: () => null }));
vi.mock('@/lib/api/public-env', () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  getRealtimeWsOrigin: () => 'wss://realtime.test',
}));

import { useTopic } from '@weldsuite/realtime/react';
import { WeldChatCallProvider, useWeldChatCall } from './weldchat-call-context';

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

/** Mount the provider and get into a connected call (`call_1` in `ch_1`). */
async function startConnectedCall() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <WeldChatCallProvider>{children}</WeldChatCallProvider>
    </QueryClientProvider>
  );
  render(<Probe />, { wrapper });
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
  rtk.handlers.clear();
  rtk.log.length = 0;
  rtk.self.audioEnabled = true;
  rtk.self.videoEnabled = true;
  vi.clearAllMocks();
  api.post.mockImplementation(async (path: string) => {
    rtk.log.push(`api:${path}`);
    return { data: { callId: 'call_1', authToken: 'tok_1', participants: [], callType: 'video' } };
  });
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
  /** Mount the provider idle and deliver a `call_incoming` event on the user topic. */
  function ringIncoming() {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>
        <WeldChatCallProvider>{children}</WeldChatCallProvider>
      </QueryClientProvider>
    );
    render(<Probe />, { wrapper });
    const onTopicEvent = vi.mocked(useTopic).mock.calls.at(-1)?.[1];
    if (!onTopicEvent) throw new Error('no topic handler registered');
    act(() => {
      onTopicEvent({
        event: 'call_incoming',
        data: { callId: 'call_9', channelId: 'ch_9', callType: 'voice', callerName: 'Sam' },
      } as Parameters<typeof onTopicEvent>[0]);
    });
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
