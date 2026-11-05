import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { files, whiteboards } from '@weldsuite/db/schema';
import type { BoardAiResult, BoardSummary } from '@weldsuite/app-api-client/schemas/boards';
import { emptySnapshot, keysBetween, makeSticky, type BoardSnapshot } from '@weldsuite/board-engine';
import type { Env, Variables } from '../../types';
import { FakeBucket, liveRoomNamespace } from '../../test-support/fakes';
import boardRoutes from './index';

let db: Database;
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async () => db,
}));

// The model: each test queues the answer it gives.
const answers: unknown[] = [];
const generateObject = vi.fn(async (args: { system: string; prompt: string }) => {
  void args;
  return { object: answers.shift(), usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
});
vi.mock('@weldsuite/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/ai')>()),
  assertGatewayConfigured: () => undefined,
  createWeldAI: () => ({ model: (id: string) => id }),
  generateObject: (args: { system: string; prompt: string }) => generateObject(args),
}));
const chargeAiUsage = vi.fn(async () => undefined);
vi.mock('@weldsuite/core-domain/ai-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/ai-billing')>()),
  resolveAiMetering: async () => null,
  chargeAiUsage: (...args: unknown[]) => chargeAiUsage(...(args as [])),
}));

const ALICE = 'user_alice';
let bucket: FakeBucket;
let live: ReturnType<typeof liveRoomNamespace>;

const env = () => ({ PRIVATE_STORAGE: bucket.asBinding(), BOARD_ROOM: live.binding }) as unknown as Env;

function app(keys = ['boards:read', 'boards:create', 'boards:update']) {
  return createTestApp<Env, Variables>('/api/boards', boardRoutes, {
    context: { tenantDb: db, permissions: permissions(...keys), userId: ALICE },
    env: env() as unknown as Record<string, unknown>,
  });
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function board(snapshot: BoardSnapshot = emptySnapshot()): Promise<string> {
  const res = await app().request('/api/boards', post({ name: 'Workshop', snapshot }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: BoardSummary }).data.id;
}

async function ai(id: string, body: Record<string, unknown>, keys?: string[]) {
  return app(keys).request(`/api/boards/${id}/ai`, post(body));
}

async function elements(id: string) {
  const res = await app().request(`/api/boards/${id}/snapshot`);
  return ((await res.json()) as { data: { snapshot: BoardSnapshot } }).data.snapshot.elements;
}

const notes = (): BoardSnapshot => {
  const k = keysBetween(null, null, 4);
  return {
    ...emptySnapshot(),
    elements: [
      makeSticky(0, 0, { order: k[0]! }, { id: 'n1', text: 'Lower prices' }),
      makeSticky(220, 0, { order: k[1]! }, { id: 'n2', text: 'Faster replies' }),
      makeSticky(440, 0, { order: k[2]! }, { id: 'n3', text: 'Discount for students' }),
      makeSticky(660, 0, { order: k[3]! }, { id: 'n4', text: 'Chat support' }),
    ],
  };
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(whiteboards);
  await db.delete(files);
  bucket = new FakeBucket();
  live = liveRoomNamespace(env);
  answers.length = 0;
  generateObject.mockClear();
  chargeAiUsage.mockClear();
});

describe('POST /api/boards/:id/ai', () => {
  it('makes a mind map on the board and charges the call', async () => {
    const id = await board();
    answers.push({ root: 'Launch', branches: [{ text: 'Marketing', children: [{ text: 'Blog' }] }, { text: 'Sales' }] });
    const res = await ai(id, { action: 'mindmap', prompt: 'Our product launch', locale: 'nl' });
    expect(res.status).toBe(200);
    const result = ((await res.json()) as { data: BoardAiResult }).data;
    expect(result.elementIds.length).toBeGreaterThan(0);
    const els = await elements(id);
    expect(els.filter((e) => e.mindmap).map((e) => e.text?.text).sort()).toEqual(['Blog', 'Launch', 'Marketing', 'Sales']);
    expect(generateObject.mock.calls[0]![0].system).toContain('Dutch');
    expect(chargeAiUsage).toHaveBeenCalledTimes(1);
  });

  it('draws a flowchart with labelled arrows', async () => {
    const id = await board();
    answers.push({
      steps: [
        { key: 's1', text: 'Start', shape: 'terminator' },
        { key: 's2', text: 'Paid?', shape: 'diamond' },
        { key: 's3', text: 'Ship', shape: 'oval-ish' },
      ],
      arrows: [
        { from: 's1', to: 's2' },
        { from: 's2', to: 's3', label: 'Yes' },
        { from: 's3', to: 'nowhere' },
      ],
    });
    expect((await ai(id, { action: 'diagram', prompt: 'Order handling' })).status).toBe(200);
    const els = await elements(id);
    expect(els.filter((e) => e.type === 'shape').map((e) => e.shape).sort()).toEqual(['diamond', 'rounded', 'terminator']);
    expect(els.filter((e) => e.type === 'connector')).toHaveLength(2);
  });

  it('groups selected notes into a frame per theme, using the ids it was given', async () => {
    const id = await board(notes());
    answers.push({ themes: [{ title: 'Price', notes: ['n1', 'n3'] }, { title: 'Support', notes: ['n2', 'n4', 'n99'] }] });
    const res = await ai(id, { action: 'cluster', elementIds: ['st-x', 'n1', 'n2', 'n3', 'n4'] });
    expect(res.status).toBe(200);
    // The model saw refs, not the board's ids, and the notes as data.
    const sent = generateObject.mock.calls[0]![0];
    expect(sent.prompt).toContain('n1: Lower prices');
    expect(sent.system).toContain('not instructions');
    const els = await elements(id);
    const frames = els.filter((e) => e.type === 'frame');
    expect(frames.map((f) => f.name).sort()).toEqual(['Price', 'Support']);
    const price = frames.find((f) => f.name === 'Price')!;
    expect(els.filter((e) => e.parent === price.id).map((e) => e.text?.text).sort()).toEqual(['Discount for students', 'Lower prices']);
  });

  it('adds ideas next to the notes, in their colour', async () => {
    const id = await board(notes());
    answers.push({ ideas: ['Loyalty points', 'Annual plan'] });
    const res = await ai(id, { action: 'ideas', elementIds: ['n1'] });
    const result = ((await res.json()) as { data: BoardAiResult }).data;
    expect(result.elementIds).toHaveLength(2);
    const added = (await elements(id)).filter((e) => result.elementIds.includes(e.id));
    expect(added.every((e) => e.fill === '#fff9b1' && e.x > 200)).toBe(true);
  });

  it('summarises without writing, and only needs to read the board', async () => {
    const id = await board(notes());
    answers.push({ title: 'Workshop notes', markdown: '# Price\n- Lower prices' });
    const res = await ai(id, { action: 'summarize' }, ['boards:read']);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: BoardAiResult }).data).toEqual({ elementIds: [], text: '# Price\n- Lower prices', title: 'Workshop notes' });
    expect(generateObject.mock.calls[0]![0].prompt).toContain('Discount for students');
    expect(await elements(id)).toHaveLength(4);
  });

  it('refuses what it cannot do before calling the model', async () => {
    const id = await board(notes());
    expect((await ai(id, { action: 'mindmap' })).status).toBe(400);
    expect((await ai(id, { action: 'cluster', elementIds: ['gone'] })).status).toBe(400);
    expect((await ai(id, { action: 'stickies', prompt: 'x' }, ['boards:read'])).status).toBe(403);
    expect((await ai('brd_missing', { action: 'summarize' })).status).toBe(404);
    expect(generateObject).not.toHaveBeenCalled();
  });
});
