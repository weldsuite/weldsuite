import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomClient } from './room-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function recordSockets(): string[] {
  const sockets: string[] = [];
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    constructor(url: string) {
      sockets.push(url);
    }
    addEventListener(): void {}
    close(): void {}
    send(): void {}
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  return sockets;
}

describe('RoomClient workspace (membership mode)', () => {
  it("names the member's workspace next to the token, keeping the room's own parameters", async () => {
    const sockets = recordSockets();
    const room = new RoomClient({
      url: 'wss://realtime.example/ws/support/ws_acme?userName=Bea',
      getToken: async () => 'tok_1',
      workspace: 'ws_acme',
    });
    void room.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const url = new URL(sockets[0]!);
    expect(url.pathname).toBe('/ws/support/ws_acme');
    expect(url.searchParams.get('token')).toBe('tok_1');
    expect(url.searchParams.get('workspace')).toBe('ws_acme');
    expect(url.searchParams.get('userName')).toBe('Bea');
    room.disconnect();
  });

  it('sends no workspace for a widget visitor or without membership mode', async () => {
    const sockets = recordSockets();
    const room = new RoomClient({ url: 'wss://realtime.example/ws/conversation/conv_1', getToken: async () => 'widget' });
    void room.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(new URL(sockets[0]!).searchParams.has('workspace')).toBe(false);
    room.disconnect();
  });
});
