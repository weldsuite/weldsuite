import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleCreateCustomer } from './customer';
import { makeActionContext } from '../../test/ctx';

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return impl(url, init);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const okResponse = () =>
  new Response(
    JSON.stringify({
      success: true,
      created: true,
      customer: { id: 'company_1', name: 'Acme', email: 'hi@acme.test', status: 'customer' },
    }),
    { status: 200 },
  );

describe('create_customer', () => {
  it('posts the customer to the internal endpoint with tenant + chain depth', async () => {
    const calls = stubFetch(okResponse);
    const ctx = makeActionContext({
      env: { INTERNAL_API_SECRET: 'secret', APP_API_URL: 'https://app-api-test.weldsuite.org/' },
      chainDepth: 1,
    });

    const res = await handleCreateCustomer({ name: '  Acme ', email: 'hi@acme.test', phone: '' }, ctx);

    expect(res).toEqual({ created: true, customerId: 'company_1', name: 'Acme', email: 'hi@acme.test' });
    expect(calls[0].url).toBe(
      'https://app-api-test.weldsuite.org/api/internal/workflow-actions/create-customer',
    );
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer secret');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({
      workspaceId: 'ws_test',
      userId: 'user_test',
      chainDepth: 1,
      skipIfEmailExists: true,
      customer: { name: 'Acme', email: 'hi@acme.test' },
    });
  });

  it('lets the step opt out of email de-duplication', async () => {
    const calls = stubFetch(okResponse);
    await handleCreateCustomer(
      { name: 'Acme', skipIfEmailExists: false },
      makeActionContext({ env: { INTERNAL_API_SECRET: 's' } }),
    );
    expect(JSON.parse(String(calls[0].init?.body)).skipIfEmailExists).toBe(false);
  });

  it('throws without a name (e.g. an unresolved template)', async () => {
    await expect(
      handleCreateCustomer({ name: '  ' }, makeActionContext({ env: { INTERNAL_API_SECRET: 's' } })),
    ).rejects.toThrow(/name is required/i);
  });

  it('surfaces the endpoint error body on failure', async () => {
    stubFetch(() => new Response('{"success":false,"error":"boom"}', { status: 500 }));
    await expect(
      handleCreateCustomer({ name: 'Acme' }, makeActionContext({ env: { INTERNAL_API_SECRET: 's' } })),
    ).rejects.toThrow(/Create customer failed: 500.*boom/);
  });

  it('calls the ConnectInternal entrypoint without a secret or public fetch when it is bound', async () => {
    const calls = stubFetch(okResponse);
    const entrypoint = vi.fn(async (_url: string, _init?: RequestInit) => okResponse());
    const ctx = makeActionContext({ env: { CONNECT_INTERNAL: { fetch: entrypoint } as never } });

    const res = await handleCreateCustomer({ name: 'Acme' }, ctx);

    expect((res as { customerId: string }).customerId).toBe('company_1');
    expect(calls).toHaveLength(0);
    const [url, init] = entrypoint.mock.calls[0];
    expect(url).toBe('https://internal/api/internal/workflow-actions/create-customer');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(JSON.parse(String(init?.body)).customer).toEqual({ name: 'Acme' });
  });

  it('falls back to the secret-guarded HTTP route when the entrypoint is not deployed yet', async () => {
    const calls = stubFetch(okResponse);
    const entrypoint = vi.fn(async () => {
      throw new Error('Worker "connect-api" has no entrypoint named "ConnectInternal"');
    });
    const ctx = makeActionContext({ env: { CONNECT_INTERNAL: { fetch: entrypoint } as never, INTERNAL_API_SECRET: 'secret' } });

    await handleCreateCustomer({ name: 'Acme' }, ctx);

    expect(entrypoint).toHaveBeenCalledTimes(1);
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer secret');
  });

  it('fails clearly when the internal secret is missing', async () => {
    await expect(handleCreateCustomer({ name: 'Acme' }, makeActionContext())).rejects.toThrow(
      /INTERNAL_API_SECRET/,
    );
  });
});
