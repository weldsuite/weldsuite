import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { sheetsAdapter, valuesOp, type Engine, type Op } from '@weldsuite/sheets-engine';
import { createCollabApp } from '../src/app';
import { MemoryObjectStore } from '../src/runtime/objects';
import type { CollabServer } from '../src/server';
import { connect, type TestClient } from './client';

const ORG = 'org_test';
const SHEET = 'sht_1';
const KEY = `workspaces/${ORG}/sheets/${SHEET}/workbook.json.gz`;
const NAME = `${ORG}:${SHEET}`;
const SECRET = 'collab-secret';
const META = { workspaceId: ORG, sheetId: SHEET, snapshotKey: KEY };

type Sheet = TestClient<Engine, Op>;
const running: CollabServer[] = [];
const clients: Sheet[] = [];

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

async function join(base: string, userId: string): Promise<Sheet> {
  const ticket = (await rpc(base, 'SHEET_ROOM', NAME, 'admit', [
    { ...META, userId, name: userId, picture: null, color: '#2563eb', canEdit: true, canComment: false },
  ])) as string;
  const client = await connect<Engine, Op>(`ws://${base}/api/sheets/connect?ticket=${ticket}`, sheetsAdapter() as never, {
    'x-internal-secret': SECRET,
  });
  clients.push(client);
  return client;
}

const cell = (c: Sheet, tab: string, row: number, col: number) => c.client.state!.getValue(tab, row, col);

describe('collab-rooms: SheetRoom on Node', () => {
  it('lets two people edit one sheet, formulas included, and keeps it across a restart', async () => {
    const store = new MemoryObjectStore();
    const base = await start(store);
    const made = (await rpc(base, 'SHEET_ENGINE', '', 'newSheet', ['Budget'])) as { checkpoint: { $bytes: string } };
    await store.put(KEY, new Uint8Array(Buffer.from(made.checkpoint.$bytes, 'base64')), { contentType: 'application/gzip' });

    const alice = await join(base, 'user_alice');
    const bob = await join(base, 'user_bob');
    const tab = alice.client.state!.workbook.sheets[0]!.id;
    expect(alice.client.state!.workbook.sheets[0]!.name).toBe('Budget');
    alice.client.apply(valuesOp(tab, { row: 0, col: 0 }, [[2, 3]]));
    bob.client.apply(valuesOp(tab, { row: 1, col: 0 }, [['=A1*B1']]));
    await alice.until(() => !alice.client.hasPending && !bob.client.hasPending && alice.client.revision === 2 && bob.client.revision === 2);
    expect(cell(alice, tab, 1, 0)).toBe(6);
    expect(cell(bob, tab, 1, 0)).toBe(6);

    // The agent tools' read goes through the room as well.
    const read = (await rpc(base, 'SHEET_ROOM', NAME, 'readRange', [META, { range: 'A1:B2' }])) as { values: unknown[][] };
    expect(read.values[1]![0]).toBe(6);

    await alice.close();
    await bob.close();
    await alice.until(() => {
      const object = store.objects.get(KEY);
      return !!object && (JSON.parse(gunzipSync(object.bytes).toString()) as { revision: number }).revision === 2;
    });
    const other = await start(store);
    const carol = await join(other, 'user_carol');
    expect(cell(carol, tab, 1, 0)).toBe(6);
  });
});
