/**
 * Covers the thin app-api adapter: domain factories + the credits balance GET.
 */

import appApi from '@/services/app-api';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub = require('@weldsuite/api-client/client') as {
  __client: Record<string, jest.Mock>;
  __resetClient: () => void;
  createClientApi: jest.Mock;
};
const client = stub.__client;
const resetClient = stub.__resetClient;

beforeEach(() => {
  resetClient();
});

describe('app-api adapter', () => {
  it('wires domain clients for weldagent, agents, ai, and push tokens', () => {
    expect(appApi.weldagent).toEqual({ __domain: 'weldagent' });
    expect(appApi.agents).toEqual({ __domain: 'agents' });
    expect(appApi.ai).toEqual({ __domain: 'ai' });
    expect(appApi.pushTokens).toEqual({ __domain: 'pushTokens' });
    expect(appApi.notifications).toEqual({ __domain: 'notifications' });
  });

  it('GET /credits/balance through the shared client', async () => {
    client.get.mockResolvedValue({
      data: { currentBalance: 42, monthlyAllocation: 100, isExhausted: false },
    });

    const res = await appApi.credits.balance();

    expect(client.get).toHaveBeenCalledWith('/credits/balance');
    expect(res.data.currentBalance).toBe(42);
  });

  it('createClientApi receives the token getter used by AuthGuard', () => {
    const opts = stub.createClientApi.mock.calls[0][0] as {
      getToken: () => Promise<string | null>;
    };
    expect(typeof opts.getToken).toBe('function');
  });
});
