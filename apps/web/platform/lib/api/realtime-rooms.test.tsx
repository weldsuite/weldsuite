/**
 * The room sockets (WeldDesk conversations, WeldChat channels, WeldMeet chat)
 * get their URL from `realtimeSocketUrl`, so in membership mode they name the
 * workspace the way the hub socket does; without realtime they don't connect.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ activeWorkspaceId: 'ws_a' as string | null }));
const env = vi.hoisted(() => ({ origin: 'wss://app.example.eu' }));
const rooms = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('@/lib/auth', () => ({
  getActiveWorkspaceId: () => auth.activeWorkspaceId,
  useAuth: () => ({ getToken: async () => 'token' }),
}));
vi.mock('@/lib/api/public-env', () => ({ getRealtimeWsOrigin: () => env.origin }));
vi.mock('@weldsuite/realtime/client', () => {
  const off = () => undefined;
  class RoomClient {
    isConnected = false;
    constructor(options: { url: string }) {
      rooms.urls.push(options.url);
    }
    on() {
      return off;
    }
    onTyping() {
      return off;
    }
    onPresence() {
      return off;
    }
    onConnectionChange() {
      return off;
    }
    connect() {
      return Promise.resolve();
    }
    enterPresence() {}
    disconnect() {}
  }
  return { RoomClient };
});

import { useDeskConversationRoom } from '@/hooks/welddesk/use-desk-live';
import { useWeldDeskRealtime } from '@/hooks/welddesk/use-welddesk-realtime';
import { useWeldChatRoom } from '@/hooks/weldchat/use-weldchat-room';
import { useMeetingChatRoom } from '@/hooks/weldmeet/use-meeting-chat-room';

const useDeskRealtime = (conversationId: string, enabled = true) =>
  useWeldDeskRealtime({ conversationId, role: 'agent', onMessage: vi.fn(), onEvent: vi.fn(), enabled });

afterEach(() => {
  vi.restoreAllMocks();
  rooms.urls = [];
  auth.activeWorkspaceId = 'ws_a';
  env.origin = 'wss://app.example.eu';
});

describe('room sockets', () => {
  it('name the active workspace in membership mode', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    renderHook(() => useDeskConversationRoom('dconv_1'));
    renderHook(() => useDeskRealtime('dconv_2'));
    renderHook(() => useWeldChatRoom('ch_1'));
    renderHook(() => useMeetingChatRoom('mtg_1'));

    expect(rooms.urls).toEqual([
      'wss://app.example.eu/ws/conversation/dconv_1?workspace=ws_a',
      'wss://app.example.eu/ws/conversation/dconv_2?workspace=ws_a',
      'wss://app.example.eu/ws/chat/ch_1?workspace=ws_a',
      'wss://app.example.eu/ws/chat/meet_mtg_1?workspace=ws_a',
    ]);
  });

  it('keep the plain path when the token names the workspace', () => {
    auth.activeWorkspaceId = null;
    renderHook(() => useWeldChatRoom('ch_1'));
    expect(rooms.urls).toEqual(['wss://app.example.eu/ws/chat/ch_1']);
  });

  it('stay closed without realtime or without a room', () => {
    env.origin = '';
    renderHook(() => useDeskConversationRoom('dconv_1'));
    renderHook(() => useDeskRealtime('dconv_2'));
    renderHook(() => useWeldChatRoom('ch_1'));
    renderHook(() => useMeetingChatRoom('mtg_1'));

    env.origin = 'wss://app.example.eu';
    renderHook(() => useDeskConversationRoom(undefined));
    renderHook(() => useDeskRealtime('dconv_2', false));
    renderHook(() => useWeldChatRoom(null));
    renderHook(() => useMeetingChatRoom(null));

    expect(rooms.urls).toEqual([]);
  });
});
