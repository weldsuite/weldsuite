import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

type Handler = (payload?: Record<string, unknown>) => void;

const rtk = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: Record<string, unknown>) => void>(),
}));

vi.mock('@cloudflare/realtimekit', () => ({
  default: {
    init: vi.fn(async () => ({
      self: {
        name: 'Me',
        audioEnabled: true,
        videoEnabled: false,
        on: (event: string, handler: Handler) => {
          rtk.handlers.set(event, handler);
        },
        enableAudio: vi.fn(),
        disableAudio: vi.fn(),
      },
      participants: { joined: { on: vi.fn(), toArray: () => [] } },
      join: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
    })),
  },
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
  rtk.handlers.clear();
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
