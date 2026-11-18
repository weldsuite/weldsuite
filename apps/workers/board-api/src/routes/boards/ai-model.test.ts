/**
 * WeldBoard's AI actions with the model stubbed at the HTTP level
 * (`@weldsuite/ai/testing`), so both backends run them: Global on
 * `@weldsuite/ai`, the Kubernetes editions on `weldsuite-ai` (feature
 * `board`) between the engine's `aiPrepare` and `aiPlan`. Conformance-ready;
 * the mock answers by the request's content, never by call order.
 *
 * Prompts and charges are asserted on TypeScript in ai.test.ts, with the AI
 * layer mocked in-process.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockModel, type MockChatReply, type MockChatRequest } from '@weldsuite/ai/testing';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceTenantDb } from '@weldsuite/worker-kit/testing/conformance';
import type { Database } from '@weldsuite/worker-kit';
import { files, whiteboards } from '@weldsuite/db/schema';
import type { BoardAiResult, BoardSummary } from '@weldsuite/app-api-client/schemas/boards';
import { emptySnapshot, keysBetween, makeSticky, type BoardSnapshot } from '@weldsuite/board-engine';
import type { Env, Variables } from '../../types';
import { FakeBucket, liveRoomNamespace } from '../../test-support/fakes';
import { boardEngineNamespace } from '../../engine-ops';
import boardRoutes from './index';

let db: Database;
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  // The rooms' database: in conformance mode, the TypeScript run's copy while it runs.
  getTenantDbForWorkspace: async () => conformanceTenantDb(db),
}));

// Conformance mode runs every write on both backends.
vi.setConfig({ testTimeout: 120_000 });

/** The model: each action's answer, by what it is asked. */
function answer(request: MockChatRequest): MockChatReply {
  const system = request.system;
  if (system.startsWith('You make mind maps')) {
    return { json: { root: 'Launch', branches: [{ text: 'Marketing', children: [{ text: 'Blog' }] }, { text: 'Sales' }] } };
  }
  if (system.startsWith('You draw flowcharts')) {
    return {
      json: {
        steps: [
          { key: 's1', text: 'Start', shape: 'terminator' },
          { key: 's2', text: 'Paid?', shape: 'diamond' },
          { key: 's3', text: 'Ship', shape: 'oval-ish' },
        ],
        arrows: [
          { from: 's1', to: 's2' },
          { from: 's2', to: 's3', label: 'Yes' },
        ],
      },
    };
  }
  if (system.startsWith('You group whiteboard notes')) {
    return { json: { themes: [{ title: 'Price', notes: ['n1', 'n3'] }, { title: 'Support', notes: ['n2', 'n4', 'n99'] }] } };
  }
  if (system.startsWith('You suggest more ideas')) return { json: { ideas: ['Loyalty points', 'Annual plan'] } };
  if (system.startsWith('You summarise whiteboards')) return { json: { title: 'Workshop notes', markdown: '# Price\n- Lower prices' } };
  return { json: {} };
}

const mock = createMockModel({ chat: answer });

/** The board engine, for the Rust backend in conformance mode; the routes run it in process. */
const engineBinding = { BOARD_ENGINE: boardEngineNamespace() };
const ALICE = 'user_alice';
let bucket: FakeBucket;
let live: ReturnType<typeof liveRoomNamespace>;

const env = (withAi = true) =>
  ({ PRIVATE_STORAGE: bucket.asBinding(), BOARD_ROOM: live.binding, ...engineBinding, ...(withAi ? mock.env : {}) }) as unknown as Env;

function app(keys = ['boards:read', 'boards:create', 'boards:update'], withAi = true) {
  return createTestApp<Env, Variables>('/api/boards', boardRoutes, {
    context: { tenantDb: db, permissions: permissions(...keys), userId: ALICE },
    env: env(withAi) as unknown as Record<string, unknown>,
  });
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function board(snapshot: BoardSnapshot = emptySnapshot()): Promise<string> {
  const res = await app().request('/api/boards', post({ name: 'Workshop', snapshot }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: BoardSummary }).data.id;
}

const ai = (id: string, body: Record<string, unknown>, keys?: string[], withAi = true) =>
  app(keys, withAi).request(`/api/boards/${id}/ai`, post(body));

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
  vi.stubGlobal('fetch', mock.fetch);
  db = (await createPgliteDb()).db;
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.delete(whiteboards);
  await db.delete(files);
  bucket = new FakeBucket();
  live = liveRoomNamespace(env);
});

describe('POST /api/boards/:id/ai', () => {
  it('makes a mind map on the board', async () => {
    const id = await board();
    const res = await ai(id, { action: 'mindmap', prompt: 'Our product launch', locale: 'nl' });
    expect(res.status).toBe(200);
    const result = ((await res.json()) as { data: BoardAiResult }).data;
    expect(result.elementIds.length).toBeGreaterThan(0);
    const els = await elements(id);
    expect(els.filter((e) => e.mindmap).map((e) => e.text?.text).sort()).toEqual(['Blog', 'Launch', 'Marketing', 'Sales']);
  });

  it('draws a flowchart with labelled arrows', async () => {
    const id = await board();
    expect((await ai(id, { action: 'diagram', prompt: 'Order handling' })).status).toBe(200);
    const els = await elements(id);
    expect(els.filter((e) => e.type === 'shape').map((e) => e.shape).sort()).toEqual(['diamond', 'rounded', 'terminator']);
    expect(els.filter((e) => e.type === 'connector')).toHaveLength(2);
  });

  it('groups selected notes into a frame per theme', async () => {
    const id = await board(notes());
    const res = await ai(id, { action: 'cluster', elementIds: ['st-x', 'n1', 'n2', 'n3', 'n4'] });
    expect(res.status).toBe(200);
    const els = await elements(id);
    expect(els.filter((e) => e.type === 'frame').map((f) => f.name).sort()).toEqual(['Price', 'Support']);
  });

  it('adds ideas next to the notes, in their colour', async () => {
    const id = await board(notes());
    const res = await ai(id, { action: 'ideas', elementIds: ['n1'] });
    expect(res.status).toBe(200);
    const result = ((await res.json()) as { data: BoardAiResult }).data;
    expect(result.elementIds).toHaveLength(2);
    const added = (await elements(id)).filter((e) => result.elementIds.includes(e.id));
    expect(added.every((e) => e.fill === '#fff9b1' && e.x > 200)).toBe(true);
  });

  it('summarises without writing, and only needs to read the board', async () => {
    const id = await board(notes());
    const res = await ai(id, { action: 'summarize' }, ['boards:read']);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: BoardAiResult }).data).toEqual({ elementIds: [], text: '# Price\n- Lower prices', title: 'Workshop notes' });
    expect(await elements(id)).toHaveLength(4);
  });

  it('refuses what it cannot do, before and after the AI checks', async () => {
    const id = await board(notes());
    expect((await ai(id, { action: 'mindmap' })).status).toBe(400);
    expect((await ai(id, { action: 'cluster', elementIds: ['gone'] })).status).toBe(400);
    const one = await ai(id, { action: 'cluster', elementIds: ['n1'] });
    expect(one.status).toBe(400);
    expect(((await one.json()) as { error: { message: string } }).error.message).toBe('Select at least two notes to group');
    expect((await ai(id, { action: 'stickies', prompt: 'x' }, ['boards:read'])).status).toBe(403);
    expect((await ai('brd_missing', { action: 'summarize' })).status).toBe(404);
  });

  // Without a model the refusals still come first. The 503 that follows
  // carries the worker's own gateway message, so it is checked per backend
  // (ai.test.ts, and the Rust crate's tests), not here.
  it('refuses before the AI checks without a model too', async () => {
    const id = await board(notes());
    expect((await ai(id, { action: 'mindmap' }, undefined, false)).status).toBe(400);
    expect((await ai(id, { action: 'ideas', elementIds: ['gone'] }, undefined, false)).status).toBe(400);
  });
});
