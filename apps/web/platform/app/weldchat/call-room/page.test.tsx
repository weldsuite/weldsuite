import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Handler = (payload?: Record<string, unknown>) => void;

const rtk = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: Record<string, unknown>) => void>(),
  self: { audioEnabled: true, videoEnabled: true },
}));

/** A meeting client: what `RealtimeKitClient.init` and `initLiveKitMeeting` both return. */
function meetingClient() {
  return {
    self: {
      name: 'Me',
      get audioEnabled() {
        return rtk.self.audioEnabled;
      },
      get videoEnabled() {
        return rtk.self.videoEnabled;
      },
      on: (event: string, handler: Handler) => {
        rtk.handlers.set(event, handler);
      },
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
    },
    participants: { joined: { on: vi.fn(), toArray: () => [] } },
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
  };
}

vi.mock('@cloudflare/realtimekit', () => ({
  default: { init: vi.fn(async () => meetingClient()) },
}));

/** Which provider the deployment's runtime config names (none = Global's RealtimeKit). */
const video = vi.hoisted(() => ({
  target: { provider: 'realtimekit' } as { provider: 'realtimekit' } | { provider: 'livekit'; url: string },
  init: vi.fn(),
}));
vi.mock('@/lib/video-provider', () => ({ videoJoin: () => video.target }));
vi.mock('@weldsuite/weldmeet-ui/providers/livekit', () => ({
  initLiveKitMeeting: (options: unknown) => video.init(options),
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        callRoom: {
          connecting: 'Connecting...',
          reconnecting: 'Connection lost. Reconnecting…',
          callEnded: 'Call ended',
          unableToJoin: 'Unable to join call',
          callLinkExpired: 'The call link may have expired.',
          close: 'Close',
          videoCall: 'Video Call',
          voiceCall: 'Voice Call',
          you: 'You',
          participant: 'Participant',
        },
      },
    },
  }),
}));

import CallRoomPage from './page';

/** Fire an event the SDK emits on `meeting.self`. */
function emit(event: string, payload?: Record<string, unknown>) {
  const handler = rtk.handlers.get(event);
  if (!handler) throw new Error(`no ${event} handler registered`);
  act(() => handler(payload));
}

async function renderJoinedRoom() {
  render(<CallRoomPage />);
  await waitFor(() => expect(rtk.handlers.has('roomLeft')).toBe(true));
  emit('roomJoined', {});
  await screen.findByTestId('call-room');
}

beforeEach(() => {
  video.target = { provider: 'realtimekit' };
  video.init.mockReset();
  rtk.handlers.clear();
  rtk.self.audioEnabled = true;
  rtk.self.videoEnabled = false;
  window.history.replaceState({}, '', '/weldchat/call-room?token=tok_1&type=voice');
});

describe('CallRoomPage · connection drops', () => {
  it('stays in the call and shows a reconnecting banner when the connection drops', async () => {
    await renderJoinedRoom();

    emit('roomLeft', { state: 'disconnected' });

    expect(screen.getByTestId('call-room')).toBeTruthy();
    expect(screen.getByTestId('call-room-reconnecting').textContent).toContain('Reconnecting');
    expect(screen.queryByTestId('call-room-ended')).toBeNull();
  });

  it('clears the banner once the SDK is back in the room', async () => {
    await renderJoinedRoom();
    emit('roomLeft', { state: 'disconnected' });

    emit('roomJoined', { reconnected: true });

    expect(screen.getByTestId('call-room')).toBeTruthy();
    expect(screen.queryByTestId('call-room-reconnecting')).toBeNull();
  });

  it.each(['left', 'ended', 'kicked', 'failed'])('ends the call on roomLeft "%s"', async (state) => {
    await renderJoinedRoom();

    emit('roomLeft', { state });

    expect(screen.getByTestId('call-room-ended')).toBeTruthy();
    expect(screen.queryByTestId('call-room')).toBeNull();
  });

  it('ends the call when the SDK gives up after a drop', async () => {
    await renderJoinedRoom();
    emit('roomLeft', { state: 'disconnected' });

    emit('roomLeft', { state: 'failed' });

    expect(screen.getByTestId('call-room-ended')).toBeTruthy();
    expect(screen.queryByTestId('call-room-reconnecting')).toBeNull();
  });
});

describe('CallRoomPage · controls', () => {
  it('mutes and unmutes the microphone', async () => {
    await renderJoinedRoom();
    const mute = screen.getByTestId('call-room-mute');

    fireEvent.click(mute);
    expect(rtk.self.audioEnabled).toBe(false);

    fireEvent.click(mute);
    expect(rtk.self.audioEnabled).toBe(true);
  });

  it('turns the camera off and on in a video call', async () => {
    rtk.self.videoEnabled = true;
    window.history.replaceState({}, '', '/weldchat/call-room?token=tok_1&type=video');
    await renderJoinedRoom();
    const video = screen.getByTestId('call-room-video');

    fireEvent.click(video);
    expect(rtk.self.videoEnabled).toBe(false);

    fireEvent.click(video);
    expect(rtk.self.videoEnabled).toBe(true);
  });

  it('has no camera button in a voice call', async () => {
    await renderJoinedRoom();

    expect(screen.queryByTestId('call-room-video')).toBeNull();
  });
});

describe('CallRoomPage · provider', () => {
  it('joins a LiveKit call with the LiveKit client and the token of the link', async () => {
    const { default: RTK } = await import('@cloudflare/realtimekit');
    vi.mocked(RTK.init).mockClear();
    video.target = { provider: 'livekit', url: 'wss://lk.test' };
    video.init.mockImplementation(() => meetingClient());
    window.history.replaceState({}, '', '/weldchat/call-room?token=lk_tok&type=video');

    await renderJoinedRoom();

    expect(video.init).toHaveBeenCalledWith({
      url: 'wss://lk.test',
      token: 'lk_tok',
      defaults: { audio: true, video: true },
    });
    expect(RTK.init).not.toHaveBeenCalled();
    expect(screen.getByTestId('call-room')).toBeTruthy();
  });

  it('shows the error state when LiveKit is the provider but has no server URL', async () => {
    video.target = { provider: 'livekit', url: 'wss://lk.test' };
    video.init.mockImplementation(() => {
      throw new Error('LiveKit is the video provider, but no LiveKit server URL is configured');
    });

    render(<CallRoomPage />);

    await screen.findByTestId('call-room-error');
  });

  it('keeps joining with RealtimeKit on Global', async () => {
    const { default: RTK } = await import('@cloudflare/realtimekit');
    vi.mocked(RTK.init).mockClear();

    await renderJoinedRoom();

    expect(RTK.init).toHaveBeenCalledWith({ authToken: 'tok_1', defaults: { audio: true, video: false } });
    expect(video.init).not.toHaveBeenCalled();
  });
});
