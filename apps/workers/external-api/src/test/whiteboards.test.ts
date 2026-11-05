/**
 * `/v1/whiteboards` on WeldBoard boards: the routes turn the old WeldFlow API
 * into calls to board-api's BoardsInternal (faked here: board-api's own tests
 * cover what it does with them). Not a conformance suite: the Rust backend
 * serves this route on `project_whiteboards`, where WeldBoard is not offered.
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

const row = (id: string, name: string, elements: unknown[] = []) => ({
  id,
  projectId: 'prj_1',
  name,
  elements,
  appState: {},
  version: 1,
  lastEditedBy: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  deletedAt: null,
});

/** A BoardsInternal that answers from `boards` (id → row) and records what it was asked. */
function fakeBoards(boards: Map<string, ReturnType<typeof row>>) {
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
        const boardsList = [...boards.values()].map((b) => ({ id: b.id, name: b.name, projectId: b.projectId }));
        return reply(200, { boards: boardsList, total: boardsList.length, hasMore: false });
      }
      if (path === '/create') {
        const created = row('pwb_new', String(body.name), (body.elements as unknown[]) ?? []);
        boards.set(created.id, created);
        return reply(201, { id: created.id, row: created });
      }
      const [, id, action] = path.split('/');
      const board = boards.get(id!);
      if (!board) return reply(404);
      if (action === 'read') return reply(200, { id, row: board });
      if (action === 'update') {
        if (typeof body.name === 'string') board.name = body.name;
        if (Array.isArray(body.elements)) board.elements = body.elements;
        return reply(200, { id, row: board });
      }
      if (action === 'delete') {
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

describe('/v1/whiteboards on WeldBoard', () => {
  it('creates, lists, reads, updates and deletes through board-api, for the key\'s person', async () => {
    const fake = fakeBoards(new Map());
    const { request } = app(fake);
    const send = (method: string, path: string, body?: unknown) =>
      request(path, { method, headers: JSON_HEADERS, ...(body ? { body: JSON.stringify(body) } : {}) });

    const created = await send('POST', '/v1/whiteboards', { projectId: 'prj_1', elements: [{ id: 'n1', type: 'sticky' }] });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { data: { name: string } }).data.name).toBe('Main Whiteboard');
    expect(fake.calls[0]).toMatchObject({ path: '/create', body: { name: 'Main Whiteboard', projectId: 'prj_1' } });
    expect(fake.calls[0]!.headers['x-weld-user']).toBe('user_test');

    const listed = (await (await send('GET', '/v1/whiteboards?projectId=prj_1')).json()) as { data: { id: string; elements: unknown[] }[]; pagination: { hasMore: boolean } };
    expect(listed.data.map((r) => r.id)).toEqual(['pwb_new']);
    expect(listed.data[0]!.elements).toHaveLength(1);
    expect(fake.calls.find((c) => c.path === '/find')!.body).toMatchObject({ projectId: 'prj_1', limit: 20, offset: 0 });

    expect((await send('PATCH', '/v1/whiteboards/pwb_new', { name: 'Ideas', elements: [] })).status).toBe(200);
    expect(fake.calls.at(-1)).toMatchObject({ path: '/pwb_new/update', body: { name: 'Ideas', elements: [] } });
    const read = (await (await send('GET', '/v1/whiteboards/pwb_new')).json()) as { data: { name: string } };
    expect(read.data.name).toBe('Ideas');

    expect((await send('DELETE', '/v1/whiteboards/pwb_new')).status).toBe(204);
    expect((await send('DELETE', '/v1/whiteboards/pwb_new')).status).toBe(404);
    expect((await send('GET', '/v1/whiteboards/pwb_new')).status).toBe(404);
  });

  it('acts as the workspace key when it has no person, and lists every project', async () => {
    const fake = fakeBoards(new Map([['pwb_a', row('pwb_a', 'Roadmap')]]));
    const session: ApiKeySession = {
      keyId: 'key_ws',
      keyType: 'workspace',
      workspaceId: 'ws_test',
      userId: null,
      scopes: ['whiteboards:read'],
      tier: 'enterprise',
      databaseUrl: null,
      licensedApps: null,
    };
    const res = await app(fake, session).request('/v1/whiteboards');
    expect(res.status).toBe(200);
    expect(fake.calls[0]!.headers['x-weld-workspace-key']).toBe('key_ws');
    expect(fake.calls[0]!.body).toMatchObject({ projects: true });
    // Read scope only: no writes.
    expect((await app(fake, session).request('/v1/whiteboards', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ projectId: 'prj_1' }) })).status).toBe(403);
  });

  it('needs a project to create one, and says so when this server has no WeldBoard', async () => {
    const fake = fakeBoards(new Map());
    const noProject = await app(fake).request('/v1/whiteboards', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Loose' }) });
    expect(noProject.status).toBe(400);
    const bare = createExternalTestApp({});
    expect((await bare.request('/v1/whiteboards')).status).toBe(503);
  });
});
