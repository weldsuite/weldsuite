import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestId } from './request-id';

describe('requestId middleware', () => {
  it('forwards an existing X-Request-Id header back on the response', async () => {
    const app = new Hono();
    app.use('*', requestId());
    app.get('/', (c) => c.text('ok'));

    const res = await app.request('/', {
      headers: { 'X-Request-Id': 'req_test_42' },
    });
    expect(res.headers.get('X-Request-Id')).toBe('req_test_42');
  });

  it('mints a UUID when no header is present', async () => {
    const app = new Hono();
    app.use('*', requestId());
    app.get('/', (c) => c.text('ok'));

    const res = await app.request('/');
    const id = res.headers.get('X-Request-Id');
    expect(id).toBeTruthy();
    // crypto.randomUUID() shape: 8-4-4-4-12 hex.
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('makes the id available on `c.get("requestId")`', async () => {
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use('*', requestId());
    app.get('/', (c) => c.json({ id: c.get('requestId') }));

    const res = await app.request('/', {
      headers: { 'X-Request-Id': 'req_visible' },
    });
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('req_visible');
  });
});
