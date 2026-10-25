import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { docVersions, docs, files } from '@weldsuite/db/schema';
import { encode, toFrames, type ClientMessage } from '@weldsuite/collab';
import { DocModel, addComment, applyOp, caretAt, type DocPresence, type Op } from '@weldsuite/docs-engine';
import type { Env } from '../types';
import { FakeBucket, FakeSocket, fakeObjectState, type DocServerMessage } from '../test-support/fakes';
import { createDoc, snapshotKeyFor } from '../services/docs';
import { versionKeyFor } from '../services/versions';
import { readSnapshot, writeSnapshot } from './snapshot';
import { DocRoom, replyCode, type Admission } from './doc-room';
import { connectToRoom, isConnectRequest } from './connect';

let db: Database;
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async () => db,
}));

const WORKSPACE = 'org_room_test';

let bucket: FakeBucket;
let state: ReturnType<typeof fakeObjectState>;
let docId: string;
let env: Env;

function admission(userId: string, canEdit = true, canComment = false): Admission {
  return {
    workspaceId: WORKSPACE,
    docId,
    snapshotKey: snapshotKeyFor(WORKSPACE, docId),
    userId,
    name: userId,
    picture: null,
    color: '#2563eb',
    canEdit,
    canComment,
  };
}

/** Admits `userId` and connects a socket for them. */
async function join(room: DocRoom, userId: string, canEdit = true, canComment = false): Promise<FakeSocket> {
  const ticket = await room.admit(admission(userId, canEdit, canComment));
  const socket = new FakeSocket();
  expect(await room.accept(socket.asSocket(), ticket.split('.')[1]!)).toBe('ok');
  return socket;
}

type Message = ClientMessage<Op, DocPresence>;
const send = (room: DocRoom, socket: FakeSocket, msg: Message) => room.webSocketMessage(socket.asSocket(), encode(msg));
const typeAt = (at: number, text: string): Op => ({ type: 'insert', story: 'body', at, content: { text } });
const ofType = <T extends DocServerMessage['type']>(socket: FakeSocket, type: T) =>
  socket.messages().filter((m): m is Extract<DocServerMessage, { type: T }> => m.type === type);
const bodyText = (doc: ReturnType<DocModel['toSnapshot']>) => doc.stories['body']!.text;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(docVersions);
  await db.delete(docs);
  await db.delete(files);
  bucket = new FakeBucket();
  state = fakeObjectState();
  env = { PRIVATE_STORAGE: bucket.asBinding() } as unknown as Env;
  docId = 'doc_room';
  const size = await writeSnapshot(bucket.asBinding(), snapshotKeyFor(WORKSPACE, docId), { revision: 0, doc: DocModel.create().toSnapshot() });
  await createDoc(db, { workspaceId: WORKSPACE, docId, name: 'Room test', folderId: null, userId: 'alice', snapshotSize: size });
});

describe('DocRoom', () => {
  it('admits each ticket once', async () => {
    const room = new DocRoom(state.ctx, env);
    const ticket = await room.admit(admission('alice'));
    const secret = ticket.split('.')[1]!;
    expect(ticket.split('.')[0]).toBe('a'.repeat(64));
    expect(await room.accept(new FakeSocket().asSocket(), secret)).toBe('ok');
    expect(await room.accept(new FakeSocket().asSocket(), secret)).toBe('invalid');
    expect(await room.accept(new FakeSocket().asSocket(), 'made-up')).toBe('invalid');
  });

  it('orders edits between people, logs them and checkpoints when everyone leaves', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, bob, { type: 'hello', revision: null });
    expect(ofType(alice, 'welcome')[0]).toMatchObject({ revision: 0, canEdit: true });
    expect(ofType(alice, 'peerJoined')[0]!.peer.userId).toBe('bob');

    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: typeAt(0, 'Hello') });
    expect(ofType(alice, 'ack')).toEqual([{ type: 'ack', batchId: 'a:1', revision: 1 }]);
    expect(ofType(bob, 'op')[0]).toMatchObject({ revision: 1, batchId: 'a:1' });
    expect(state.storage.data.has('op:000000000001')).toBe(true);
    expect(state.storage.alarm).not.toBeNull();

    // The object is evicted while both sockets stay open; a new instance picks up.
    const woken = new DocRoom(state.ctx, env);
    await send(woken, bob, { type: 'submit', batchId: 'b:1', baseRevision: 1, op: typeAt(5, ' world') });
    expect(ofType(bob, 'ack').at(-1)).toMatchObject({ revision: 2 });
    expect(ofType(alice, 'op').at(-1)).toMatchObject({ revision: 2, batchId: 'b:1' });

    await woken.webSocketClose(alice.asSocket(), 1000, 'bye');
    expect(ofType(bob, 'peerLeft')).toHaveLength(1);
    await woken.webSocketClose(bob.asSocket(), 1000, 'bye');

    const stored = await readSnapshot(bucket.asBinding(), snapshotKeyFor(WORKSPACE, docId));
    expect(stored?.revision).toBe(2);
    expect(bodyText(stored!.doc)).toContain('Hello world');
    const [row] = await db.select().from(docs).where(eq(docs.id, docId));
    expect(row).toMatchObject({ revision: 2, snapshotRevision: 2, updatedById: 'bob', content: null });
  });

  it('replays the log over the checkpoint after a restart', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: typeAt(0, 'one') });
    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: typeAt(3, ' two') });

    const restarted = new DocRoom(fakeObjectStateFrom(state), env);
    const carol = await join(restarted, 'carol');
    await send(restarted, carol, { type: 'hello', revision: null });
    const welcome = ofType(carol, 'welcome')[0]!;
    expect(welcome.revision).toBe(2);
    expect(bodyText(welcome.snapshot!)).toContain('one two');
    // Alice's batch, re-sent after a reconnect, is acknowledged and not applied again.
    await send(restarted, carol, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: typeAt(3, ' two') });
    expect(ofType(carol, 'ack').at(-1)).toEqual({ type: 'ack', batchId: 'a:2', revision: 2 });
  });

  it('answers a close without a code with a normal close', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await room.webSocketClose(alice.asSocket(), 1005, '');
    expect(alice.closed).toEqual({ code: 1000, reason: '' });
    expect([1000, 1001, 4001, 1005, 1006, 1015, 999, 5000].map(replyCode)).toEqual([1000, 1001, 4001, 1000, 1000, 1000, 1000, 1000]);
  });

  it('keeps viewers from editing', async () => {
    const room = new DocRoom(state.ctx, env);
    const viewer = await join(room, 'vic', false);
    await send(room, viewer, { type: 'hello', revision: null });
    expect(ofType(viewer, 'welcome')[0]!.canEdit).toBe(false);
    await send(room, viewer, { type: 'submit', batchId: 'v:1', baseRevision: 0, op: typeAt(0, 'nope') });
    expect(ofType(viewer, 'reject')[0]).toMatchObject({ reason: 'read-only' });
    expect(state.storage.data.has('op:000000000001')).toBe(false);
  });

  it('relays presence and refuses a malformed one', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, bob, { type: 'hello', revision: null });
    await send(room, alice, { type: 'presence', presence: { story: 'body', anchor: 1, head: 3 } });
    expect(ofType(bob, 'presence')[0]).toMatchObject({ presence: { story: 'body', anchor: 1, head: 3 } });
    // A selection that is not a position never reaches anyone.
    await room.webSocketMessage(alice.asSocket(), JSON.stringify({ type: 'presence', presence: { story: 'body', anchor: -1, head: 'x' } }));
    expect(ofType(bob, 'presence')).toHaveLength(1);
  });

  it('refuses a garbled batch and logs nothing', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    const garbled = { type: 'submit', batchId: 'a:1', baseRevision: 0, op: { type: 'insert', story: 'body', at: 'zero', content: { text: 5 } } };
    await room.webSocketMessage(alice.asSocket(), JSON.stringify(garbled));
    // Never applied or logged; the sender is told, and gets the room's state back.
    expect(alice.messages().map((m) => m.type)).toEqual(['welcome', 'reject', 'resync']);
    expect(state.storage.data.has('op:000000000001')).toBe(false);
    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 0, op: typeAt(0, 'fine') });
    expect(ofType(alice, 'ack')).toEqual([{ type: 'ack', batchId: 'a:2', revision: 1 }]);
  });

  it('rebuilds itself when an op fails to apply', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, bob, { type: 'hello', revision: null });
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: typeAt(0, 'a') });
    // An adapter bug: the document throws halfway through applying a batch.
    const loaded = (room as unknown as { room: { state: DocModel } }).room;
    vi.spyOn(loaded.state.body, 'insert').mockImplementation(() => {
      throw new Error('engine bug');
    });
    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: typeAt(1, 'b') });
    expect(ofType(alice, 'reject')).toEqual([{ type: 'reject', batchId: 'a:2', reason: 'invalid' }]);
    expect([alice.closed?.code, bob.closed?.code]).toEqual([1012, 1012]);
    expect(state.storage.data.has('op:000000000002')).toBe(false);

    // Everyone comes back to a room rebuilt from the checkpoint and the log.
    state.sockets.length = 0;
    const again = await join(room, 'alice');
    await send(room, again, { type: 'hello', revision: 1 });
    expect(ofType(again, 'welcome')[0]).toMatchObject({ revision: 1, catchUp: [] });
    await send(room, again, { type: 'submit', batchId: 'a:3', baseRevision: 1, op: typeAt(1, 'c') });
    expect(ofType(again, 'ack')).toEqual([{ type: 'ack', batchId: 'a:3', revision: 2 }]);
  });

  it('joins a batch sent in parts', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    const frames = toFrames(encode({ type: 'submit', batchId: 'a:big', baseRevision: 0, op: typeAt(0, 'lorem ipsum '.repeat(500)) }), 'p1', 1000);
    expect(frames.length).toBeGreaterThan(3);
    for (const frame of frames) await room.webSocketMessage(alice.asSocket(), frame);
    expect(ofType(alice, 'ack')).toEqual([{ type: 'ack', batchId: 'a:big', revision: 1 }]);
  });

  const meta = () => ({ workspaceId: WORKSPACE, docId, snapshotKey: snapshotKeyFor(WORKSPACE, docId) });

  it('serves its live document, edits not checkpointed yet included', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: typeAt(0, 'Live text') });

    const live = await room.snapshot(meta());
    expect(live.revision).toBe(1);
    expect(bodyText(JSON.parse(live.json))).toContain('Live text');
    // Not yet in R2.
    expect((await readSnapshot(bucket.asBinding(), snapshotKeyFor(WORKSPACE, docId)))?.revision).toBe(0);
  });

  it('serves a document nobody has open, from its checkpoint', async () => {
    const room = new DocRoom(state.ctx, env);
    const live = await room.snapshot(meta());
    expect(live.revision).toBe(0);
    expect(JSON.parse(live.json)).toEqual(DocModel.create().toSnapshot());
    expect(state.storage.data.get('meta')).toEqual(meta());
  });

  it('lets commenters comment, and nothing else', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const cara = await join(room, 'cara', false, true);
    const vic = await join(room, 'vic', false);
    for (const s of [alice, cara, vic]) await send(room, s, { type: 'hello', revision: null });
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: typeAt(0, 'Some text') });

    const local = DocModel.create();
    applyOp(local, typeAt(0, 'Some text'));
    const comment = (by: string) => addComment(local, caretAt('body', 1), { id: by, name: by }, { body: `from ${by}` }, () => `c_${by}`, 1).op;

    // Their own discussion goes in.
    await send(room, cara, { type: 'submit', batchId: 'c:1', baseRevision: 1, op: comment('cara') });
    expect(ofType(cara, 'ack')).toEqual([{ type: 'ack', batchId: 'c:1', revision: 2 }]);
    // Text, or a discussion in someone else's name, is refused like a viewer's edit.
    await send(room, cara, { type: 'submit', batchId: 'c:2', baseRevision: 2, op: typeAt(0, 'x') });
    await send(room, cara, { type: 'submit', batchId: 'c:3', baseRevision: 2, op: comment('alice') });
    expect(ofType(cara, 'reject').map((r) => [r.batchId, r.reason])).toEqual([
      ['c:2', 'read-only'],
      ['c:3', 'read-only'],
    ]);
    // A viewer without docs:comment cannot comment at all.
    await send(room, vic, { type: 'submit', batchId: 'v:1', baseRevision: 2, op: comment('vic') });
    expect(ofType(vic, 'reject')[0]).toMatchObject({ batchId: 'v:1', reason: 'read-only' });
    // Editors comment as they like.
    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 2, op: comment('alice') });
    expect(ofType(alice, 'ack').at(-1)).toMatchObject({ batchId: 'a:2', revision: 3 });

    const live = JSON.parse((await room.snapshot(meta())).json) as ReturnType<DocModel['toSnapshot']>;
    expect(live.comments?.map((c) => c.id)).toEqual(['c_alice', 'c_cara']);
    expect(live.stories['body']!.text).toBe('Some text\n');
  });

  it('restores a version: saves the document as it was, replaces it and reloads everyone', async () => {
    const room = new DocRoom(state.ctx, env);
    const alice = await join(room, 'alice');
    const bob = await join(room, 'bob');
    await send(room, alice, { type: 'hello', revision: null });
    await send(room, bob, { type: 'hello', revision: null });
    await send(room, alice, { type: 'submit', batchId: 'a:1', baseRevision: 0, op: typeAt(0, 'First') });
    const versionKey = versionKeyFor(meta().snapshotKey, 'docv_good');
    expect(await room.saveVersion(meta(), versionKey)).toMatchObject({ revision: 1 });
    expect(bodyText((await readSnapshot(bucket.asBinding(), versionKey))!.doc)).toBe('First\n');
    await send(room, alice, { type: 'submit', batchId: 'a:2', baseRevision: 1, op: typeAt(5, ' second') });

    const outcome = await room.restoreVersion({ doc: meta(), versionId: 'docv_good', versionKey, autoVersionId: 'docv_auto', userId: 'bob' });
    expect(outcome).toEqual({ ok: true, revision: 3 });

    // The document as it was is an automatic version.
    const [auto] = await db.select().from(docVersions).where(eq(docVersions.id, 'docv_auto'));
    expect(auto).toMatchObject({ docId, revision: 2, name: null, createdById: 'bob', snapshotKey: versionKeyFor(meta().snapshotKey, 'docv_auto') });
    expect(bodyText((await readSnapshot(bucket.asBinding(), auto!.snapshotKey))!.doc)).toBe('First second\n');
    // The version is the document now, checkpointed at the next revision, and the old log is gone.
    const checkpoint = (await readSnapshot(bucket.asBinding(), meta().snapshotKey))!;
    expect([checkpoint.revision, bodyText(checkpoint.doc)]).toEqual([3, 'First\n']);
    expect([...state.storage.data.keys()].filter((k) => k.startsWith('op:'))).toEqual([]);
    const [row] = await db.select().from(docs).where(eq(docs.id, docId));
    expect(row).toMatchObject({ revision: 3, updatedById: 'bob' });

    // Everyone starts over from it.
    for (const s of [alice, bob]) {
      const restored = ofType(s, 'restored');
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ revision: 3, versionId: 'docv_good', userId: 'bob' });
      expect(bodyText(restored[0]!.snapshot)).toBe('First\n');
    }
    // A batch made on the replaced document is stale; one on the restored one goes in.
    await send(room, bob, { type: 'submit', batchId: 'b:1', baseRevision: 2, op: typeAt(0, 'late ') });
    expect(ofType(bob, 'reject')[0]).toMatchObject({ batchId: 'b:1', reason: 'stale' });
    await send(room, alice, { type: 'submit', batchId: 'a:3', baseRevision: 3, op: typeAt(5, '!') });
    expect(ofType(alice, 'ack').at(-1)).toEqual({ type: 'ack', batchId: 'a:3', revision: 4 });

    // After a restart, an op of the replaced document left in the log is never replayed.
    state.storage.data.set('op:000000000002', { revision: 2, batchId: 'a:2', clientId: 'x', op: typeAt(0, 'ghost ') });
    const restarted = new DocRoom(fakeObjectStateFrom(state), env);
    const live = await restarted.snapshot(meta());
    expect(live.revision).toBe(4);
    expect(bodyText(JSON.parse(live.json))).toBe('First!\n');
  });

  it('refuses to restore a version whose snapshot is gone', async () => {
    const room = new DocRoom(state.ctx, env);
    const outcome = await room.restoreVersion({
      doc: meta(),
      versionId: 'docv_gone',
      versionKey: versionKeyFor(meta().snapshotKey, 'docv_gone'),
      autoVersionId: 'docv_auto',
      userId: 'alice',
    });
    expect(outcome).toEqual({ ok: false, reason: 'missing_version' });
    expect(await db.select().from(docVersions)).toEqual([]);
    expect((await readSnapshot(bucket.asBinding(), meta().snapshotKey))?.revision).toBe(0);
  });
});

describe('room socket', () => {
  const upgrade = (ticket: string) =>
    new Request(`https://docs-api.test/api/docs/connect?ticket=${ticket}`, { headers: { Upgrade: 'websocket' } });

  it('forwards a well-formed ticket to the room it names', async () => {
    const fetched: string[] = [];
    const roomEnv = {
      DOC_ROOM: {
        idFromString: (id: string) => ({ id }),
        get: ({ id }: { id: string }) => ({ fetch: async () => (fetched.push(id), new Response('ok')) }),
      },
    } as unknown as Env;
    expect(isConnectRequest(upgrade('x'))).toBe(true);
    expect((await connectToRoom(upgrade(`${'b'.repeat(64)}.secret-secret-secret`), roomEnv)).status).toBe(200);
    expect(fetched).toEqual(['b'.repeat(64)]);
    expect((await connectToRoom(upgrade('nope'), roomEnv)).status).toBe(401);
    expect((await connectToRoom(new Request('https://docs-api.test/api/docs/connect'), roomEnv)).status).toBe(426);
  });
});

/** The same stored state with no sockets and nothing in memory: a fresh start. */
function fakeObjectStateFrom(previous: ReturnType<typeof fakeObjectState>) {
  const next = fakeObjectState();
  for (const [k, v] of previous.storage.data) next.storage.data.set(k, v);
  return next.ctx;
}
