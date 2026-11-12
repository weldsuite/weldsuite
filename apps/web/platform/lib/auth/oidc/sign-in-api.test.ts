import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/public-env', () => ({ getAppApiUrl: () => 'https://weldsuite.example.eu' }));

import {
  confirmPasswordReset,
  endProviderSession,
  loadSignInRequest,
  requestPasswordReset,
  SignInError,
  signInWithPassword,
  signUp,
  verifySecondFactor,
} from './sign-in-api';

function answer(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The one request made: its URL and options. */
function sent(): { url: string; init: RequestInit; body: unknown } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

describe('the sign-in screens’ calls', () => {
  it('reads where a sign-in stands, with the cookie the backend keeps the provider session in', async () => {
    fetchMock.mockResolvedValue(answer(200, { data: { status: 'expired' } }));

    await expect(loadSignInRequest('V2_1&x=y')).resolves.toEqual({ status: 'expired' });

    const { url, init } = sent();
    expect(url).toBe('https://weldsuite.example.eu/api/sign-in/request?authRequest=V2_1%26x%3Dy');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.cache).toBe('no-store');
  });

  it('posts JSON and answers with the next step', async () => {
    const step = { status: 'complete', redirectUrl: 'https://weldsuite.example.eu/auth/sso-callback?code=c' };
    fetchMock.mockResolvedValue(answer(200, { data: step }));

    await expect(signInWithPassword('V2_1', 'jane@acme.test', 'Secret123')).resolves.toEqual(step);

    const { url, init, body } = sent();
    expect(url).toBe('https://weldsuite.example.eu/api/sign-in/password');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(body).toEqual({ authRequest: 'V2_1', email: 'jane@acme.test', password: 'Secret123' });
  });

  it('sends each form as the backend reads it', async () => {
    fetchMock.mockImplementation(async () => answer(200, { data: { status: 'expired' } }));

    await verifySecondFactor('V2_1', 'email_code', '12345678');
    await signUp('V2_1', { firstName: 'Jane', lastName: 'Doe', email: 'jane@acme.test', password: 'Secret123!' });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies).toEqual([
      { authRequest: 'V2_1', factor: 'email_code', code: '12345678' },
      { authRequest: 'V2_1', firstName: 'Jane', lastName: 'Doe', email: 'jane@acme.test', password: 'Secret123!' },
    ]);
  });

  it('resolves to nothing on 204', async () => {
    fetchMock.mockImplementation(async () => answer(204));

    await expect(requestPasswordReset('jane@acme.test')).resolves.toBeUndefined();
    await expect(confirmPasswordReset({ userId: '42', code: 'ABC123', password: 'Changed456' })).resolves.toBeUndefined();
  });

  it('names a refusal by its code', async () => {
    fetchMock.mockResolvedValue(
      answer(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }),
    );

    const refusal = await signInWithPassword('V2_1', 'jane@acme.test', 'nope').catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(SignInError);
    expect((refusal as SignInError).code).toBe('INVALID_CREDENTIALS');
  });

  it('reads anything else as unavailable: an unknown code, a page that is not JSON, no answer at all', async () => {
    fetchMock.mockResolvedValueOnce(answer(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } }));
    fetchMock.mockResolvedValueOnce(new Response('<html></html>', { status: 404 }));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refusal = await loadSignInRequest('V2_1').catch((err: unknown) => err);
      expect((refusal as SignInError).code).toBe('UNAVAILABLE');
    }
  });

  it('never fails a sign-out', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(endProviderSession()).resolves.toBeUndefined();
    expect(sent().url).toBe('https://weldsuite.example.eu/api/sign-in/sign-out');
  });
});
