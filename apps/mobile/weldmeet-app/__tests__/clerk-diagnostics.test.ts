import { frontendApiFromPublishableKey, probeClerkFrontendApi } from '../utils/clerk-diagnostics';

// base64("example.clerk.accounts.dev$")
const KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk';

describe('frontendApiFromPublishableKey', () => {
  it('decodes the frontend API host', () => {
    expect(frontendApiFromPublishableKey(KEY)).toBe('example.clerk.accounts.dev');
    expect(frontendApiFromPublishableKey(KEY.replace('pk_test_', 'pk_live_'))).toBe('example.clerk.accounts.dev');
  });

  it('is null for a missing or malformed key', () => {
    expect(frontendApiFromPublishableKey(undefined)).toBeNull();
    expect(frontendApiFromPublishableKey('')).toBeNull();
    expect(frontendApiFromPublishableKey('pk_test_')).toBeNull();
    expect(frontendApiFromPublishableKey('not-a-key')).toBeNull();
  });
});

describe('probeClerkFrontendApi', () => {
  it('reports the HTTP status of the environment endpoint', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200 });
    await expect(probeClerkFrontendApi(KEY, fetchImpl)).resolves.toBe('example.clerk.accounts.dev: HTTP 200');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.clerk.accounts.dev/v1/environment?_is_native=1');
  });

  it('reports a network error instead of throwing', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('Network request failed'));
    await expect(probeClerkFrontendApi(KEY, fetchImpl)).resolves.toBe(
      'example.clerk.accounts.dev: Network request failed',
    );
  });

  it('gives up when there is no response', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ status: number }>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(probeClerkFrontendApi(KEY, fetchImpl, 20)).resolves.toBe(
      'example.clerk.accounts.dev: no response after 0s',
    );
  });

  it('says so when the key is missing', async () => {
    const fetchImpl = jest.fn();
    await expect(probeClerkFrontendApi(undefined, fetchImpl)).resolves.toMatch(/PUBLISHABLE_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
