import { describe, expect, it, vi } from 'vitest';
import { fetchConnectInternal } from './connect-internal';

const init = { method: 'POST', headers: { 'X-Workspace-Id': 'org_1' } };
const ok = () => new Response('{}', { status: 200 });

describe('fetchConnectInternal', () => {
  it('calls the ConnectInternal entrypoint without the secret when it is bound', async () => {
    const entrypoint = vi.fn(async () => ok());
    const appApi = vi.fn(async () => ok());
    await fetchConnectInternal(
      { CONNECT_INTERNAL: { fetch: entrypoint } as never, APP_API: { fetch: appApi } as never, INTERNAL_API_SECRET: 's' },
      '/api/integrations/connections/intc_1/sync',
      init,
    );

    expect(appApi).not.toHaveBeenCalled();
    expect(entrypoint).toHaveBeenCalledWith('https://internal/api/integrations/connections/intc_1/sync', init);
    const sent = (entrypoint.mock.calls[0] as unknown as [string, typeof init])[1];
    expect(sent.headers).not.toHaveProperty('X-Internal-Secret');
  });

  it('falls back to app-api with the secret when the binding is absent', async () => {
    const appApi = vi.fn(async () => ok());
    await fetchConnectInternal({ APP_API: { fetch: appApi } as never, INTERNAL_API_SECRET: 's' }, '/api/x', init);

    expect(appApi).toHaveBeenCalledWith('https://internal/api/x', {
      ...init,
      headers: { 'X-Workspace-Id': 'org_1', 'X-Internal-Secret': 's' },
    });
  });

  it('falls back when the entrypoint is not deployed yet', async () => {
    const entrypoint = vi.fn(async () => {
      throw new Error('The service binding targets an entrypoint "ConnectInternal" that does not exist');
    });
    const appApi = vi.fn(async () => ok());
    const res = await fetchConnectInternal(
      { CONNECT_INTERNAL: { fetch: entrypoint } as never, APP_API: { fetch: appApi } as never, INTERNAL_API_SECRET: 's' },
      '/api/x',
      init,
    );

    expect(res.status).toBe(200);
    expect(appApi).toHaveBeenCalledTimes(1);
  });

  it('does not retry other failures on the fallback path', async () => {
    const entrypoint = vi.fn(async () => {
      throw new Error('network lost');
    });
    const appApi = vi.fn(async () => ok());
    await expect(
      fetchConnectInternal(
        { CONNECT_INTERNAL: { fetch: entrypoint } as never, APP_API: { fetch: appApi } as never },
        '/api/x',
        init,
      ),
    ).rejects.toThrow('network lost');
    expect(appApi).not.toHaveBeenCalled();
  });
});
