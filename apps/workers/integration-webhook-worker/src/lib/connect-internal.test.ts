import { describe, expect, it, vi } from 'vitest';
import { fetchConnectInternal, hasConnectInternal } from './connect-internal';

const ok = () => new Response('{}', { status: 200 });
const init = () => ({ method: 'POST', headers: new Headers({ 'X-Workspace-Id': 'org_1' }), body: '{}' });

describe('fetchConnectInternal', () => {
  it('calls the ConnectInternal entrypoint without the secret when it is bound', async () => {
    const entrypoint = vi.fn(async (..._args: unknown[]) => ok());
    const appApi = vi.fn(async () => ok());
    await fetchConnectInternal(
      { CONNECT_INTERNAL: { fetch: entrypoint } as never, APP_API: { fetch: appApi } as never, INTERNAL_API_SECRET: 's' },
      '/api/integrations/connections/intc_1/connector-event',
      init(),
    );

    expect(appApi).not.toHaveBeenCalled();
    const [url, sent] = entrypoint.mock.calls[0] as [string, { headers: Headers; body: string }];
    expect(url).toBe('https://internal/api/integrations/connections/intc_1/connector-event');
    expect(sent.headers.get('X-Internal-Secret')).toBeNull();
    expect(sent.headers.get('X-Workspace-Id')).toBe('org_1');
    expect(sent.body).toBe('{}');
  });

  it('falls back to app-api with the secret when the binding is absent', async () => {
    const appApi = vi.fn(async (..._args: unknown[]) => ok());
    await fetchConnectInternal({ APP_API: { fetch: appApi } as never, INTERNAL_API_SECRET: 's' }, '/api/x', init());

    const [url, sent] = appApi.mock.calls[0] as [string, { headers: Headers }];
    expect(url).toBe('https://internal/api/x');
    expect(sent.headers.get('X-Internal-Secret')).toBe('s');
    expect(sent.headers.get('X-Workspace-Id')).toBe('org_1');
  });

  it('falls back when the entrypoint is not deployed yet, but not on other failures', async () => {
    const appApi = vi.fn(async () => ok());
    const missing = vi.fn(async () => {
      throw new Error('The service binding targets an entrypoint "ConnectInternal" that does not exist');
    });
    const res = await fetchConnectInternal(
      { CONNECT_INTERNAL: { fetch: missing } as never, APP_API: { fetch: appApi } as never },
      '/api/x',
      init(),
    );
    expect(res.status).toBe(200);
    expect(appApi).toHaveBeenCalledTimes(1);

    const broken = vi.fn(async () => {
      throw new Error('network lost');
    });
    await expect(
      fetchConnectInternal(
        { CONNECT_INTERNAL: { fetch: broken } as never, APP_API: { fetch: appApi } as never },
        '/api/x',
        init(),
      ),
    ).rejects.toThrow('network lost');
    expect(appApi).toHaveBeenCalledTimes(1);
  });

  it('reports whether any path is bound', () => {
    expect(hasConnectInternal({})).toBe(false);
    expect(hasConnectInternal({ APP_API: {} as never })).toBe(true);
    expect(hasConnectInternal({ CONNECT_INTERNAL: {} as never })).toBe(true);
  });
});
