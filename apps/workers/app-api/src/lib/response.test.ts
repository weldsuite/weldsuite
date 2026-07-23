import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { success, list, noContent, error, cursorPagination } from './response';

describe('response helpers', () => {
  it('success() wraps the payload in a `data` envelope with 200', async () => {
    const app = new Hono();
    app.get('/x', (c) => success(c, { id: '1', name: 'Acme' }));
    const res = await app.request('/x');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: '1', name: 'Acme' } });
  });

  it('success() supports 201 for creation responses', async () => {
    const app = new Hono();
    app.post('/x', (c) => success(c, { id: '1' }, 201));
    const res = await app.request('/x', { method: 'POST' });
    expect(res.status).toBe(201);
  });

  it('list() emits `{ data, pagination }`', async () => {
    const app = new Hono();
    app.get('/x', (c) => list(c, [{ id: '1' }], cursorPagination(1, false, null)));
    const res = await app.request('/x');
    expect(await res.json()).toEqual({
      data: [{ id: '1' }],
      pagination: { totalCount: 1, hasMore: false, cursor: null },
    });
  });

  it('noContent() returns 204 with empty body', async () => {
    const app = new Hono();
    app.delete('/x', (c) => noContent(c));
    const res = await app.request('/x', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  describe('error.*', () => {
    it.each([
      ['badRequest', 400, 'BAD_REQUEST'],
      ['unauthorized', 401, 'UNAUTHORIZED'],
      ['forbidden', 403, 'FORBIDDEN'],
      ['conflict', 409, 'CONFLICT'],
      ['internal', 500, 'INTERNAL_ERROR'],
    ] as const)('%s emits %i with code %s', async (method, status, code) => {
      const app = new Hono();
      app.get('/x', (c) => (error[method] as (ctx: Context, m?: string) => Response)(c, 'msg'));
      const res = await app.request('/x');
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe('msg');
    });

    it('notFound() builds the message from the resource + id', async () => {
      const app = new Hono();
      app.get('/x', (c) => error.notFound(c, 'Company', 'company_42'));
      const res = await app.request('/x');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toContain('company_42');
    });
  });
});
