import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { FORWARDED_BY_HEADER, moduleForwarder } from './forward';

function setup(env: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', moduleForwarder({ from: 'app-api' }));
  app.all('*', (c) => c.text('served by app-api'));
  return (path: string, init?: RequestInit) => app.request(path, init, env);
}

function fakeWorker(body = 'served by module') {
  return {
    fetch: vi.fn(async (req: Request) =>
      new Response(body, { headers: { 'x-seen-by': req.headers.get(FORWARDED_BY_HEADER) ?? '' } }),
    ),
  };
}

describe('moduleForwarder', () => {
  it('forwards enabled modules to their binding', async () => {
    const PASS_API = fakeWorker();
    const request = setup({ API_FORWARD_MODULES: 'pass', PASS_API });

    const res = await request('/api/weldpass/projects?limit=5', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: '{}',
    });

    expect(await res.text()).toBe('served by module');
    expect(res.headers.get('x-seen-by')).toBe('app-api');
    const forwarded = PASS_API.fetch.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe('/api/weldpass/projects');
    expect(new URL(forwarded.url).search).toBe('?limit=5');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get('Authorization')).toBe('Bearer t');
    expect(forwarded.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('keeps an incoming request id', async () => {
    const PASS_API = fakeWorker();
    const request = setup({ API_FORWARD_MODULES: 'pass', PASS_API });
    await request('/api/weldpass', { headers: { 'X-Request-Id': 'req_1' } });
    expect(PASS_API.fetch.mock.calls[0]![0].headers.get('X-Request-Id')).toBe('req_1');
  });

  it('leaves modules that are not enabled in app-api', async () => {
    const PASS_API = fakeWorker();
    const request = setup({ API_FORWARD_MODULES: 'host', PASS_API });
    const res = await request('/api/weldpass');
    expect(await res.text()).toBe('served by app-api');
    expect(PASS_API.fetch).not.toHaveBeenCalled();
  });

  it('never forwards core paths', async () => {
    const request = setup({ API_FORWARD_MODULES: 'pass', PASS_API: fakeWorker() });
    expect(await (await request('/api/me')).text()).toBe('served by app-api');
    expect(await (await request('/health')).text()).toBe('served by app-api');
  });

  it('falls back to app-api when the binding is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = setup({ API_FORWARD_MODULES: 'pass' });
    expect(await (await request('/api/weldpass')).text()).toBe('served by app-api');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing without API_FORWARD_MODULES', async () => {
    const PASS_API = fakeWorker();
    const request = setup({ PASS_API });
    expect(await (await request('/api/weldpass')).text()).toBe('served by app-api');
  });
});
