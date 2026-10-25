import type { ClientMessage, Outgoing, ServerMessage } from '@weldsuite/collab';
import { describe, expect, it } from 'vitest';
import { DocModel } from '../model/document';
import { applyOp } from '../ops/apply';
import { randomOp } from '../ops/random-ops';
import type { Op } from '../ops/types';
import { counterIds, rng, snapshotKey } from '../test-support';
import { createDocClient, createDocRoom, type DocPresence } from './adapter';

type Room = ReturnType<typeof createDocRoom>;
type Client = ReturnType<typeof createDocClient>;

/**
 * A room and several clients with random message delays: everyone edits at
 * random, messages arrive late and in bursts, and at the end every replica
 * must hold the room's document, with no batch refused.
 */
function simulate(seed: number, clients: number, steps: number): { room: Room; clients: Client[]; rejects: number } {
  const random = rng(seed);
  const makeId = counterIds(`x${seed}_`);
  const start = DocModel.create();
  applyOp(start, { type: 'insert', story: 'body', at: 0, content: { text: 'The quick brown fox\njumps over the lazy dog' } });
  const room = createDocRoom(start.toSnapshot(), 0);
  const toRoom: { from: string; msg: ClientMessage<Op, DocPresence> }[] = [];
  const toClient = new Map<string, ServerMessage<Op, unknown, DocPresence>[]>();
  let rejects = 0;

  const list: Client[] = [];
  for (let i = 0; i < clients; i++) {
    const id = `c${i}`;
    toClient.set(id, []);
    room.join({ clientId: id, userId: `u${i}`, name: `User ${i}`, color: '#000000', canEdit: true });
    const client = createDocClient({ sessionId: `s${i}`, send: (msg) => toRoom.push({ from: id, msg: JSON.parse(JSON.stringify(msg)) }) });
    list.push(client);
    client.start();
  }

  const route = (out: Outgoing<Op, unknown, DocPresence>[]) => {
    for (const o of out) {
      if (o.msg.type === 'reject') rejects++;
      const copy = JSON.parse(JSON.stringify(o.msg)) as ServerMessage<Op, unknown, DocPresence>;
      if (o.to) toClient.get(o.to)!.push(copy);
      else for (const [id, q] of toClient) if (id !== o.except && room.isReady(id)) q.push(copy);
    }
  };
  const deliverRoom = () => {
    const m = toRoom.shift();
    if (m) route(room.receive(m.from, m.msg));
  };
  const deliverClient = (i: number) => {
    const q = toClient.get(`c${i}`)!;
    const m = q.shift();
    if (m) list[i]!.receive(m as never);
  };

  for (let step = 0; step < steps; step++) {
    const r = random();
    const i = Math.floor(random() * clients);
    const client = list[i]!;
    if (r < 0.45 && client.state) {
      const op = randomOp(client.state, random, makeId);
      if (op) client.apply(op);
    } else if (r < 0.75) {
      deliverRoom();
    } else {
      deliverClient(i);
    }
  }
  // Drain everything.
  for (let guard = 0; guard < 100_000 && (toRoom.length || [...toClient.values()].some((q) => q.length)); guard++) {
    deliverRoom();
    for (let i = 0; i < clients; i++) while (toClient.get(`c${i}`)!.length) deliverClient(i);
  }
  return { room, clients: list, rejects };
}

describe('DocRoom simulation', () => {
  it('converges with no refused batches across many random sessions', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { room, clients, rejects } = simulate(seed, 4, 600);
      expect(rejects).toBe(0);
      const expected = snapshotKey(room.state);
      for (const c of clients) {
        expect(c.hasPending).toBe(false);
        expect(snapshotKey(c.state!)).toBe(expected);
      }
    }
  });
});
