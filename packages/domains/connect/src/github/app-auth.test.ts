import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mintGithubAppJwt, getGithubInstallationToken } from './app-auth';

// A real RSA keypair, generated once for the suite — `importRsaPrivateKey`
// (Web Crypto, PKCS#8) must accept the same PEM GitHub hands out for a real
// App, and the JWT signature must verify against the matching public key.
let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  privateKeyPem = privateKey;
  publicKeyPem = publicKey;
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mintGithubAppJwt', () => {
  it('signs a well-formed RS256 JWT verifiable against the matching public key', async () => {
    const jwt = await mintGithubAppJwt('123456', privateKeyPem);
    const [headerB64, payloadB64, signatureB64] = jwt.split('.');
    expect(headerB64).toBeTruthy();
    expect(payloadB64).toBeTruthy();
    expect(signatureB64).toBeTruthy();

    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(payload.iss).toBe('123456');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(payload.exp).toBeGreaterThan(payload.iat);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    const signature = Buffer.from(signatureB64, 'base64url');
    expect(verifier.verify(publicKeyPem, signature)).toBe(true);
  });

  it('backdates iat by ~60s to tolerate clock skew and keeps the lifetime under 10 minutes', async () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = await mintGithubAppJwt('1', privateKeyPem);
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.iat).toBeLessThanOrEqual(before);
    expect(before - payload.iat).toBeLessThanOrEqual(65);
    expect(payload.exp - payload.iat).toBe(600);
  });
});

describe('getGithubInstallationToken', () => {
  it('mints an app JWT, exchanges it for an installation token, and sends the expected headers', async () => {
    const { calls } = stubFetch(() =>
      new Response(
        JSON.stringify({ token: 'ghs_installation_token', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 201 },
      ),
    );

    const token = await getGithubInstallationToken('123456', privateKeyPem, 999);
    expect(token).toBe('ghs_installation_token');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/app/installations/999/access_tokens');
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers.Accept).toBe('application/vnd.github+json');
  });

  it('caches the token across calls while more than 5 minutes remain', async () => {
    const { calls } = stubFetch(() =>
      new Response(
        JSON.stringify({ token: 'ghs_cached', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 201 },
      ),
    );
    await getGithubInstallationToken('123456', privateKeyPem, 1001);
    const second = await getGithubInstallationToken('123456', privateKeyPem, 1001);
    expect(second).toBe('ghs_cached');
    expect(calls).toHaveLength(1);
  });

  it('mints a fresh token once the cached one is within 5 minutes of expiry', async () => {
    let call = 0;
    stubFetch(() => {
      call += 1;
      const expiresAt = call === 1 ? new Date(Date.now() + 200_000) : new Date(Date.now() + 3600_000);
      return new Response(JSON.stringify({ token: `ghs_${call}`, expires_at: expiresAt.toISOString() }), {
        status: 201,
      });
    });
    const first = await getGithubInstallationToken('123456', privateKeyPem, 1002);
    const second = await getGithubInstallationToken('123456', privateKeyPem, 1002);
    expect(first).toBe('ghs_1');
    expect(second).toBe('ghs_2');
  });

  it('throws with the response body when the exchange fails', async () => {
    stubFetch(() => new Response('installation suspended', { status: 403 }));
    await expect(getGithubInstallationToken('123456', privateKeyPem, 1003)).rejects.toThrow(
      /GitHub installation token exchange failed \(403\): installation suspended/,
    );
  });

  it('rejects a non-positive-integer installation id before hitting the network', async () => {
    const { mock } = stubFetch(() => new Response('{}'));
    await expect(getGithubInstallationToken('123456', privateKeyPem, -1)).rejects.toThrow(/Invalid GitHub installation id/);
    await expect(getGithubInstallationToken('123456', privateKeyPem, 1.5)).rejects.toThrow(/Invalid GitHub installation id/);
    expect(mock).not.toHaveBeenCalled();
  });
});
