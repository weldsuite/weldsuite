/**
 * `/v1/boards`: the routes turn the public API into calls to board-api's
 * BoardsInternal (faked here: board-api's own tests cover what it does with
 * them: access, layout, the room). Not a conformance suite: the Rust backend
 * does not serve WeldBoard yet.
 */

import { describe, expect, it } from 'vitest';
import { createExternalTestApp } from './harness';
import type { ApiKeySession, Env } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface Call {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeBoard {
  id: string;
  name: string;
  projectId: string | null;
  legacy: boolean;
}

const brief = (b: FakeBoard) => ({
  ...b,
  revision: 3,
  role: 'owner',
  url: `/weldboard/${b.id}`,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  updatedById: null,
});

function fakeBoards(boards: Map<string, FakeBoard>) {
  const calls: Call[] = [];
  const reply = (status: number, data?: unknown) =>
    new Response(status === 204 ? null : JSON.stringify(status >= 400 ? { error: { code: 'NOT_FOUND', message: 'Board not found' } } : { data }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetcher = {
    fetch: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.replace(/^\/internal\/boards\/[^/]+/, '');
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      calls.push({ path, headers: init.headers as Record<string, string>, body });
      if (path === '/find') {
        const list = [...boards.values()].map(brief);
        return reply(200, { boards: list, total: list.length, hasMore: false });
      }
      if (path === '/create') {
        const created: FakeBoard = { id: 'brd_new', name: String(body.name ?? 'Untitled board'), projectId: (body.projectId as string) ?? null, legacy: false };
        boards.set(created.id, created);
        return reply(201, brief(created));
      }
      const [, id, action] = path.split('/');
      const board = boards.get(id!);
      if (!board) return reply(404);
      switch (action) {
        case 'read':
          return reply(200, body.format === 'text' ? { ...brief(board), text: 'Hello' } : { ...brief(board), elements: [{ id: 'e1', type: 'sticky', text: 'Hello' }], count: 1 });
        case 'update':
          board.name = String(body.name);
          return reply(200, { ...brief(board), row: { elements: [] } });
        case 'add':
          return reply(201, { revision: 4, elementIds: ['e2'], keys: { a: 'e2' }, url: `/weldboard/${id}` });
        case 'edit':
          return reply(200, { revision: 5, changed: ['e1'], skipped: [], url: `/weldboard/${id}` });
        case 'delete':
          boards.delete(id!);
          return reply(204);
      }
      return reply(404);
    },
  };
  return { calls, fetcher };
}

function app(boards: ReturnType<typeof fakeBoards>, session?: ApiKeySession) {
  return createExternalTestApp({ ...(session ? { session } : {}), env: { BOARDS_INTERNAL: boards.fetcher } as unknown as Partial<Env> });
}

const workspaceKey = (scopes: string[]): ApiKeySession => ({
  keyId: 'key_ws',
  keyType: 'workspace',
  workspaceId: 'ws_test',
  userId: null,
  scopes,
  tier: 'enterprise',
  databaseUrl: null,
  licensedApps: null,
});

describe('/v1/boards', () => {
  it('creates with content, reads, adds, edits, renames and deletes, for the key’s person', async () => {
    const fake = fakeBoards(new Map());
    const { request } = app(fake);
    const send = (method: string, path: string, body?: unknown) => request(path, { method, headers: JSON_HEADERS, ...(body ? { body: JSON.stringify(body) } : {}) });

    const content = { items: [{ key: 'a', type: 'sticky', text: 'Idea', color: 'pink' }] };
    const created = await send('POST', '/v1/boards', { name: 'Brainstorm', content });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { data: unknown }).data).toMatchObject({ id: 'brd_new', name: 'Brainstorm', revision: 4, keys: { a: 'e2' } });
    expect(fake.calls[0]).toMatchObject({ path: '/create', body: { name: 'Brainstorm' } });
    expect(fake.calls[0]!.headers['x-weld-user']).toBe('user_test');
    expect(fake.calls[1]).toMatchObject({ path: '/brd_new/add', body: { spec: content } });

    const listed = (await (await send('GET', '/v1/boards?search=brain')).json()) as { data: { id: string; legacy?: boolean }[] };
    expect(listed.data.map((b) => b.id)).toEqual(['brd_new']);
    expect(listed.data[0]).not.toHaveProperty('legacy');
    // A person's boards are their drive's unless they ask for the projects'.
    expect(fake.calls.at(-1)!.body).toEqual({ query: 'brain', limit: 25, offset: 0 });

    const outline = (await (await send('GET', '/v1/boards/brd_new')).json()) as { data: { elements: unknown[]; count: number } };
    expect(outline.data).toMatchObject({ count: 1, elements: [{ id: 'e1' }] });
    const text = (await (await send('GET', '/v1/boards/brd_new?format=text')).json()) as { data: { text: string } };
    expect(text.data.text).toBe('Hello');

    expect((await send('POST', '/v1/boards/brd_new/elements', { spec: { mindmap: { text: 'Plan', children: [{ text: 'Q1' }] } } })).status).toBe(201);
    expect((await send('PATCH', '/v1/boards/brd_new/elements', { changes: [{ id: 'e1', text: 'Better idea' }] })).status).toBe(200);
    expect(fake.calls.at(-1)).toMatchObject({ path: '/brd_new/edit', body: { changes: [{ id: 'e1', text: 'Better idea' }] } });
    expect(((await (await send('PATCH', '/v1/boards/brd_new', { name: 'Ideas' })).json()) as { data: { name: string } }).data.name).toBe('Ideas');

    expect((await send('DELETE', '/v1/boards/brd_new')).status).toBe(204);
    expect((await send('DELETE', '/v1/boards/brd_new')).status).toBe(404);
  });

  it('checks content before it reaches board-api', async () => {
    const fake = fakeBoards(new Map([['brd_a', { id: 'brd_a', name: 'A', projectId: null, legacy: false }]]));
    const { request } = app(fake);
    const bad = await request('/v1/boards/brd_a/elements', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ spec: { items: [{ type: 'widget', text: 'x' }] } }) });
    expect(bad.status).toBe(400);
    const none = await request('/v1/boards/brd_a/elements', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ changes: [] }) });
    expect(none.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('acts as a workspace key on project boards, within its scopes', async () => {
    const fake = fakeBoards(new Map([['brd_p', { id: 'brd_p', name: 'Roadmap', projectId: 'prj_1', legacy: false }]]));
    const reader = app(fake, workspaceKey(['boards:read']));
    expect((await reader.request('/v1/boards')).status).toBe(200);
    expect(fake.calls[0]!.headers['x-weld-workspace-key']).toBe('key_ws');
    expect(fake.calls[0]!.body).toMatchObject({ projects: true });
    expect((await reader.request('/v1/boards', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ projectId: 'prj_1' }) })).status).toBe(403);

    const writer = app(fake, workspaceKey(['boards:*']));
    const loose = await writer.request('/v1/boards', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Mine' }) });
    expect(loose.status).toBe(400);
    expect((await writer.request('/v1/boards', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ projectId: 'prj_1' }) })).status).toBe(201);
  });

  it('says so when this server has no WeldBoard', async () => {
    expect((await createExternalTestApp({}).request('/v1/boards')).status).toBe(503);
  });
});
