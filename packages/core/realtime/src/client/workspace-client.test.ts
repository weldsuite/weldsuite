import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceClient, socketUrl } from './workspace-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A WebSocket that records the URLs it is opened with and never connects. */
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

describe('socketUrl', () => {
  it('adds the token, and the workspace only when one is named', () => {
    expect(socketUrl('wss://rt.example/ws', 'a+b')).toBe('wss://rt.example/ws?token=a%2Bb');
    expect(socketUrl('wss://rt.example/ws', 't', null)).toBe('wss://rt.example/ws?token=t');
    expect(socketUrl('wss://rt.example/ws', 't', '  ')).toBe('wss://rt.example/ws?token=t');
    const url = new URL(socketUrl('wss://rt.example/ws?userName=Bea', 't', 'ws_1 &x'));
    expect(url.searchParams.get('workspace')).toBe('ws_1 &x');
    expect(url.searchParams.get('userName')).toBe('Bea');
    expect(url.search).toContain('workspace=ws_1+%26x');
  });
});

describe('WorkspaceClient workspace (membership mode)', () => {
  it('names the workspace next to the token', async () => {
    const sockets = recordSockets();
    const client = new WorkspaceClient({
      url: 'wss://realtime.example/ws',
      getToken: async () => 'tok_1',
      workspace: 'ws_acme',
    });
    void client.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const url = new URL(sockets[0]!);
    expect(url.searchParams.get('token')).toBe('tok_1');
    expect(url.searchParams.get('workspace')).toBe('ws_acme');
    client.disconnect();
  });

  it('sends no workspace when none is set (Clerk, claim-mode OIDC)', async () => {
    const sockets = recordSockets();
    for (const workspace of [undefined, null]) {
      const client = new WorkspaceClient({ url: 'wss://realtime.example/ws', getToken: async () => 'tok_1', workspace });
      void client.connect();
      await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
      expect(new URL(sockets.at(-1)!).searchParams.has('workspace')).toBe(false);
      client.disconnect();
      sockets.length = 0;
    }
  });
});

describe('WorkspaceClient.connect without a token', () => {
  it('opens no socket and stays disconnected, then connects once a token exists', async () => {
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

    let token = '';
    const client = new WorkspaceClient({ url: 'wss://realtime.example/ws', getToken: async () => token });

    await client.connect();
    expect(sockets).toEqual([]);
    expect(client.connectionState).toBe('disconnected');

    token = 'tok_1';
    void client.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]).toContain('token=tok_1');
    client.disconnect();
  });
});
