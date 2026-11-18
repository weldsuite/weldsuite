import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceClient } from './workspace-client';

afterEach(() => {
  vi.unstubAllGlobals();
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
