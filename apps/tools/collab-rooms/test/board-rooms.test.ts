import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { boardAdapter, keysBetween, makeSticky, type Board, type BoardSnapshot, type Op } from '@weldsuite/board-engine';
import { createCollabApp } from '../src/app';
import { MemoryObjectStore } from '../src/runtime/objects';
import type { CollabServer } from '../src/server';
import { connect, type TestClient } from './client';

const ORG = 'org_test';
const BOARD = 'brd_1';
const KEY = `workspaces/${ORG}/boards/${BOARD}/board.json.gz`;
const NAME = `${ORG}:${BOARD}`;
const SECRET = 'collab-secret';
const META = { workspaceId: ORG, boardId: BOARD, snapshotKey: KEY };

type BoardClient = TestClient<Board, Op>;
const running: CollabServer[] = [];
const clients: BoardClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function start(store: MemoryObjectStore): Promise<string> {
  const app = createCollabApp({ privateStore: store, database: {}, secret: SECRET, sweepMs: 3_600_000 });
  running.push(app);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

async function rpc(base: string, binding: string, name: string, method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`http://${base}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
    body: JSON.stringify({ binding, name, method, args }),
  });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (res.status !== 200) throw new Error(`${method}: ${res.status} ${body.error}`);
  return body.result;
}

/** What POST /api/boards writes before any room opens: the engine's first checkpoint. */
async function createBoard(base: string, store: MemoryObjectStore): Promise<void> {
  const made = (await rpc(base, 'BOARD_ENGINE', '', 'newBoard', [null])) as { ok: boolean; checkpoint: { $bytes: string } };
  expect(made.ok).toBe(true);
  await store.put(KEY, new Uint8Array(Buffer.from(made.checkpoint.$bytes, 'base64')), { contentType: 'application/gzip' });
}

async function join(base: string, userId: string, canEdit = true): Promise<BoardClient> {
  const ticket = (await rpc(base, 'BOARD_ROOM', NAME, 'admit', [
    { ...META, userId, name: userId, picture: null, color: '#2563eb', canEdit, canComment: false },
  ])) as string;
  const client = await connect<Board, Op>(`ws://${base}/api/boards/connect?ticket=${ticket}`, boardAdapter() as never, {
    'x-internal-secret': SECRET,
  });
  clients.push(client);
  return client;
}

const has = (c: BoardClient, id: string) => !!c.client.state?.get(id);
const settled = (c: BoardClient) => !c.client.hasPending;

describe('collab-rooms: BoardRoom on Node', () => {
  it('lets two people edit one board, and keeps it across a restart', async () => {
    const store = new MemoryObjectStore();
    const base = await start(store);
    await createBoard(base, store);

    const [first, second] = keysBetween(null, null, 2);
    const alice = await join(base, 'user_alice');
    const bob = await join(base, 'user_bob');
    alice.client.apply({ type: 'create', elements: [makeSticky(0, 0, { order: first! }, { id: 'st_a', text: 'From Alice' })] });
    await alice.until(() => settled(alice));
    await bob.until(() => has(bob, 'st_a'));
    bob.client.apply({ type: 'create', elements: [makeSticky(300, 0, { order: second! }, { id: 'st_b', text: 'From Bob' })] });
    await alice.until(() => has(alice, 'st_b') && settled(bob) && alice.client.revision === 2);
    expect(bob.client.revision).toBe(2);

    // Every committed op is in the room's storage before its ack left: a
    // pod that dies now loses nothing (a second service on the same store).
    expect((await store.list(`collab-rooms/BOARD_ROOM/`)).filter((k) => k.includes('op%3A'))).toHaveLength(2);
    const other = await start(store);
    const carol = await join(other, 'user_carol', false);
    expect(has(carol, 'st_a') && has(carol, 'st_b')).toBe(true);

    // A server write (the task cards, an agent tool), sent to everyone in the room.
    const written = (await rpc(base, 'BOARD_ROOM', NAME, 'applyOps', [META, { type: 'delete', ids: ['st_a'] }, 'user_alice'])) as {
      committed: boolean;
      revision: number;
    };
    expect(written).toMatchObject({ committed: true, revision: 3 });
    await bob.until(() => !has(bob, 'st_a'));

    // The live snapshot the REST routes read, and the engine's SVG of it.
    const live = (await rpc(base, 'BOARD_ROOM', NAME, 'snapshot', [META])) as { revision: number; json: string };
    expect(live.revision).toBe(3);
    expect((JSON.parse(live.json) as BoardSnapshot).elements.map((e) => e.id)).toEqual(['st_b']);
    const drawn = (await rpc(base, 'BOARD_ENGINE', '', 'render', [live.json, 512])) as { svg: string; elements: number };
    expect(drawn.elements).toBe(1);
    expect(drawn.svg).toContain('From Bob');

    // When the last person leaves, the room checkpoints to the board's key, with a thumbnail next to it.
    await alice.close();
    await bob.close();
    await alice.until(() => {
      const object = store.objects.get(KEY);
      return !!object && (JSON.parse(gunzipSync(object.bytes).toString()) as { revision: number }).revision === 3;
    });
    expect(store.objects.has(`workspaces/${ORG}/boards/${BOARD}/thumbnail.svg`)).toBe(true);
  });

  it("refuses a viewer's edits and a spent ticket", async () => {
    const store = new MemoryObjectStore();
    const base = await start(store);
    await createBoard(base, store);
    const viewer = await join(base, 'user_viewer', false);
    viewer.client.apply({ type: 'create', elements: [makeSticky(0, 0, {}, { id: 'nope', text: 'nope' })] });
    await viewer.until(() => settled(viewer));
    expect(has(viewer, 'nope')).toBe(false);

    const ticket = (await rpc(base, 'BOARD_ROOM', NAME, 'admit', [
      { ...META, userId: 'u', name: 'u', picture: null, color: '#000', canEdit: true, canComment: false },
    ])) as string;
    const first = await connect<Board, Op>(`ws://${base}/api/boards/connect?ticket=${ticket}`, boardAdapter() as never, { 'x-internal-secret': SECRET });
    clients.push(first);
    await expect(
      connect<Board, Op>(`ws://${base}/api/boards/connect?ticket=${ticket}`, boardAdapter() as never, { 'x-internal-secret': SECRET }),
    ).rejects.toThrow('401');
  });
});
