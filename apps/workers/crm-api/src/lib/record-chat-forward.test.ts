/**
 * Company and person chats are forwarded to chat-api over the CHAT_API
 * service binding. These tests check the forward itself: the path mapping,
 * method, body and headers, and the 503 when chat-api cannot be reached.
 * What chat-api does with the request (create, post, follow, CRM activity) is
 * covered by chat-api's routes/chat-entity-channels/integration.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { companiesRoutes } from '../routes/companies';
import { peopleRoutes } from '../routes/people';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';

interface Forwarded {
  url: string;
  method: string;
  body: string;
  headers: Headers;
}

function chatApiStub(response: () => Response = () => Response.json({ data: { forwarded: true } }, { status: 201 })) {
  const calls: Forwarded[] = [];
  const binding = {
    fetch: async (input: RequestInfo | URL) => {
      const req = input as Request;
      calls.push({ url: req.url, method: req.method, body: await req.text(), headers: req.headers });
      return response();
    },
  };
  return { calls, binding: binding as unknown as Fetcher };
}

function app(basePath: '/api/companies' | '/api/people', chatApi?: Fetcher) {
  const routes = basePath === '/api/companies' ? companiesRoutes : peopleRoutes;
  return createTestApp(basePath, routes, {
    context: { permissions: permissions('*') },
    env: chatApi ? { CHAT_API: chatApi } : {},
  });
}

describe('record chat forward to chat-api', () => {
  it('forwards a company chat post with its body and auth', async () => {
    const stub = chatApiStub();
    const res = await app('/api/companies', stub.binding).request('/api/companies/cmp_1/chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { forwarded: true } });
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(new URL(call.url).pathname).toBe('/api/chat-entity-channels/company/cmp_1/messages');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ content: 'hello' });
    expect(call.headers.get('Authorization')).toBe('Bearer token-1');
    expect(call.headers.get('X-Forwarded-By')).toBe('crm-api');
  });

  it('maps every person chat path to the person record chat', async () => {
    const stub = chatApiStub(() => Response.json({ data: null }));
    const people = app('/api/people', stub.binding);
    await people.request('/api/people/per_1/chat/channel');
    await people.request('/api/people/per_1/chat/follow', { method: 'POST' });
    await people.request('/api/people/per_1/chat/follow', { method: 'DELETE' });

    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/chat-entity-channels/person/per_1/channel',
      'POST /api/chat-entity-channels/person/per_1/follow',
      'DELETE /api/chat-entity-channels/person/per_1/follow',
    ]);
  });

  it('passes chat-api errors through unchanged', async () => {
    const stub = chatApiStub(() =>
      Response.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this entity' } }, { status: 403 }),
    );
    const res = await app('/api/companies', stub.binding).request('/api/companies/cmp_1/chat/channel');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('answers 503 when the CHAT_API binding is missing or unreachable', async () => {
    const missing = await app('/api/companies').request('/api/companies/cmp_1/chat/channel');
    expect(missing.status).toBe(503);

    const broken = { fetch: async () => { throw new Error('not running'); } } as unknown as Fetcher;
    const unreachable = await app('/api/people', broken).request('/api/people/per_1/chat/channel');
    expect(unreachable.status).toBe(503);
  });

  it('does not forward paths chat-api does not serve', async () => {
    const stub = chatApiStub();
    const res = await app('/api/companies', stub.binding).request('/api/companies/cmp_1/chat/detail');
    expect(res.status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });
});
