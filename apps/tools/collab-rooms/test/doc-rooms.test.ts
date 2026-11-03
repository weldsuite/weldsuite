import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { docsAdapter, type DocModel, type Op } from '@weldsuite/docs-engine';
import { createCollabApp } from '../src/app';
import { MemoryObjectStore } from '../src/runtime/objects';
import type { CollabServer } from '../src/server';
import { connect, type TestClient } from './client';

const ORG = 'org_test';
const DOC = 'doc_1';
const KEY = `workspaces/${ORG}/docs/${DOC}/document.json.gz`;
const NAME = `${ORG}:${DOC}`;
const SECRET = 'collab-secret';

type Doc = TestClient<DocModel, Op>;

const running: CollabServer[] = [];
const clients: Doc[] = [];

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

/** What POST /api/docs writes before any room opens: the engine's first checkpoint. */
async function createDocument(base: string, store: MemoryObjectStore): Promise<void> {
  const made = (await rpc(base, 'DOC_ENGINE', '', 'newDocument', [])) as { ok: boolean; checkpoint: { $bytes: string } };
  expect(made.ok).toBe(true);
  await store.put(KEY, new Uint8Array(Buffer.from(made.checkpoint.$bytes, 'base64')), { contentType: 'application/gzip' });
}

async function join(base: string, userId: string, canEdit = true): Promise<Doc> {
  const meta = { workspaceId: ORG, docId: DOC, snapshotKey: KEY };
  const ticket = (await rpc(base, 'DOC_ROOM', NAME, 'admit', [
    { ...meta, userId, name: userId, picture: null, color: '#2563eb', canEdit, canComment: false },
  ])) as string;
  const client = await connect<DocModel, Op>(`ws://${base}/api/docs/connect?ticket=${ticket}`, docsAdapter() as never, {
    'x-internal-secret': SECRET,
  });
  clients.push(client);
  return client;
}

const text = (c: Doc) => c.client.state!.toSnapshot().stories['body']!.text;
const settled = (c: Doc) => !c.client.hasPending;

describe('collab-rooms: DocRoom on Node', () => {
  it('lets two people edit one document, and keeps it across a restart', async () => {
    const store = new MemoryObjectStore();
    const base = await start(store);
    await createDocument(base, store);

    const alice = await join(base, 'user_alice');
    const bob = await join(base, 'user_bob');
    alice.client.apply({ type: 'insert', story: 'body', at: 0, content: { text: 'Hello' } });
    await alice.until(() => settled(alice));
    await bob.until(() => text(bob).startsWith('Hello'));
    bob.client.apply({ type: 'insert', story: 'body', at: 5, content: { text: ' world' } });
    alice.client.apply({ type: 'insert', story: 'body', at: 0, content: { text: '>> ' } });
    await alice.until(() => settled(alice) && settled(bob) && alice.client.revision === bob.client.revision && alice.client.revision === 3);
    await bob.until(() => bob.client.revision === 3);
    expect(text(alice)).toBe(text(bob));
    expect(text(alice)).toContain('>> Hello world');

    // Every committed op is in the room's storage before its ack left: a
    // pod that dies now loses nothing (a second service on the same store).
    expect((await store.list(`collab-rooms/DOC_ROOM/`)).filter((k) => k.includes('op%3A'))).toHaveLength(3);
    const other = await start(store);
    const carol = await join(other, 'user_carol', false);
    expect(text(carol)).toContain('>> Hello world');
    expect(carol.client.revision).toBe(3);

    // The live snapshot the REST route serves.
    const live = (await rpc(base, 'DOC_ROOM', NAME, 'snapshot', [{ workspaceId: ORG, docId: DOC, snapshotKey: KEY }])) as {
      revision: number;
      json: string;
    };
    expect(live.revision).toBe(3);

    // When the last person leaves, the room checkpoints to the document's key.
    await alice.close();
    await bob.close();
    await alice.until(() => {
      const object = store.objects.get(KEY);
      return !!object && (JSON.parse(gunzipSync(object.bytes).toString()) as { revision: number }).revision === 3;
    });
    const stored = JSON.parse(gunzipSync(store.objects.get(KEY)!.bytes).toString()) as { revision: number; doc: { stories: Record<string, { text: string }> } };
    expect(stored.doc.stories['body']!.text).toContain('>> Hello world');
  });

  it('refuses a viewer\'s edits and a spent ticket', async () => {
    const store = new MemoryObjectStore();
    const base = await start(store);
    await createDocument(base, store);
    const viewer = await join(base, 'user_viewer', false);
    viewer.client.apply({ type: 'insert', story: 'body', at: 0, content: { text: 'nope' } });
    await viewer.until(() => settled(viewer));
    expect(text(viewer)).not.toContain('nope');

    const ticket = (await rpc(base, 'DOC_ROOM', NAME, 'admit', [
      { workspaceId: ORG, docId: DOC, snapshotKey: KEY, userId: 'u', name: 'u', picture: null, color: '#000', canEdit: true, canComment: false },
    ])) as string;
    const first = await connect<DocModel, Op>(`ws://${base}/api/docs/connect?ticket=${ticket}`, docsAdapter() as never, { 'x-internal-secret': SECRET });
    clients.push(first);
    await expect(
      connect<DocModel, Op>(`ws://${base}/api/docs/connect?ticket=${ticket}`, docsAdapter() as never, { 'x-internal-secret': SECRET }),
    ).rejects.toThrow('401');
    // Without the service secret nothing gets in.
    const res = await fetch(`http://${base}/rpc`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});
