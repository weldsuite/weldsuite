/**
 * A co-editing client as the platform runs one (`DocConnection`), without a
 * browser: the engine's own `CollabClient` on a `ws` socket, frames and all.
 * Used by the tests here and by scripts/e2e.ts against a running stack.
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { CollabClient, FrameAssembler, decodeServer, encode, toFrames, type OtAdapter } from '@weldsuite/collab';

export interface TestClient<State, Op> {
  client: CollabClient<State, Op, unknown, unknown>;
  socket: WebSocket;
  /** Resolves once `check` holds (polled), or rejects after `ms`. */
  until(check: () => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

export async function connect<State, Op>(
  url: string,
  adapter: OtAdapter<State, Op, unknown, unknown>,
  headers: Record<string, string> = {},
): Promise<TestClient<State, Op>> {
  const socket = new WebSocket(url, { headers });
  const assembler = new FrameAssembler();
  let frame = 0;
  const client = new CollabClient<State, Op, unknown, unknown>(adapter, {
    sessionId: randomUUID(),
    send: (msg) => {
      for (const part of toFrames(encode(msg), `c${++frame}`)) socket.send(part);
    },
  });
  socket.on('message', (data) => {
    const text = assembler.accept(data.toString());
    if (text === null) return;
    const msg = decodeServer<Op, unknown, unknown>(text);
    if (msg) client.receive(msg);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('unexpected-response', (_req, res) => reject(new Error(`socket refused: ${res.statusCode}`)));
    socket.once('error', reject);
  });
  client.start();
  const until = async (check: () => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await until(() => client.state !== null);
  return {
    client,
    socket,
    until,
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === socket.CLOSED) return resolve();
        socket.once('close', () => resolve());
        socket.close(1000, 'done');
      }),
  };
}
