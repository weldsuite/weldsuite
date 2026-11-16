import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALLBACK_PAGE_HEADERS,
  DEFAULT_PAGE_TEXT,
  LoopbackSignIn,
  callbackPage,
  checkAuthorizationRequest,
  readPageText,
} from './loopback-sign-in';

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One request to the listener, with full control of the method and the Host header. */
function call(port: number, path: string, options: { method?: string; host?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `127.0.0.1:${port}` },
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const flows: LoopbackSignIn[] = [];

async function open(timeoutMs?: number): Promise<{ flow: LoopbackSignIn; port: number }> {
  const flow = await LoopbackSignIn.open(timeoutMs === undefined ? {} : { timeoutMs });
  flows.push(flow);
  const port = flow.address()?.port;
  if (!port) throw new Error('not listening');
  return { flow, port };
}

afterEach(() => {
  for (const flow of flows.splice(0)) flow.cancel();
});

function authorizeUrl(redirectUri: string, overrides: Record<string, string | null> = {}): string {
  const url = new URL('https://auth.example.eu/oauth/authorize');
  const params: Record<string, string | null> = {
    client_id: 'weldsuite-desktop',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value);
  return url.href;
}

describe('the loopback listener', () => {
  it('listens on 127.0.0.1 only, on a port the OS picked', async () => {
    const { flow, port } = await open();
    expect(flow.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(port).toBeGreaterThan(0);
    expect(flow.redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
  });

  it('hands back the callback whose state matches, answers with the page, then closes', async () => {
    const { flow, port } = await open();
    const outcome = flow.expect('state-1');
    const answer = await call(port, '/callback?code=code-1&state=state-1&iss=https%3A%2F%2Fauth.example.eu');
    expect(answer.status).toBe(200);
    expect(answer.body).toContain(DEFAULT_PAGE_TEXT.successTitle.replace("'", '&#39;'));
    expect(answer.headers['content-security-policy']).toContain("default-src 'none'");
    expect(answer.headers['cache-control']).toBe('no-store');
    await expect(outcome).resolves.toEqual({
      status: 'callback',
      callbackUrl: `http://127.0.0.1:${port}/callback?code=code-1&state=state-1&iss=https%3A%2F%2Fauth.example.eu`,
    });
    await expect(call(port, '/callback?code=code-2&state=state-1')).rejects.toThrow();
  });

  it('refuses a state that is not this sign-in’s, and keeps waiting for the right one', async () => {
    const { flow, port } = await open();
    const outcome = flow.expect('state-1');
    for (const path of ['/callback?code=x&state=state-2', '/callback?code=x', '/callback?code=x&state=']) {
      const answer = await call(port, path);
      expect(answer.status, path).toBe(400);
      expect(answer.body).not.toContain('x&state');
    }
    await call(port, '/callback?code=code-1&state=state-1');
    await expect(outcome).resolves.toMatchObject({ status: 'callback' });
  });

  it('refuses everything before the authorization request went out', async () => {
    const { flow, port } = await open();
    expect((await call(port, '/callback?code=x&state=state-1')).status).toBe(400);
    expect(flow.expecting).toBe(false);
  });

  it('answers only GET /callback on its own Host', async () => {
    const { flow, port } = await open();
    flow.expect('state-1');
    expect((await call(port, '/callback?code=x&state=state-1', { method: 'POST' })).status).toBe(405);
    expect((await call(port, '/favicon.ico')).status).toBe(404);
    // A site that points a name of its own at 127.0.0.1 sends that name.
    expect((await call(port, '/callback?code=x&state=state-1', { host: 'evil.example:80' })).status).toBe(400);
    expect((await call(port, '/callback?code=x&state=state-1', { host: `localhost:${port}` })).status).toBe(400);
  });

  it('shows the failure page when the provider refused, and still hands the answer back', async () => {
    const { flow, port } = await open();
    const outcome = flow.expect('state-1', readPageText({ ...DEFAULT_PAGE_TEXT, failureTitle: 'Niet gelukt', lang: 'nl' }));
    const answer = await call(port, '/callback?error=access_denied&state=state-1');
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('Niet gelukt');
    expect(answer.body).toContain('<html lang="nl">');
    await expect(outcome).resolves.toMatchObject({ status: 'callback' });
  });

  it('gives up after its timeout and stops listening', async () => {
    const { flow, port } = await open(30);
    await expect(flow.expect('state-1')).resolves.toEqual({ status: 'timeout' });
    await expect(call(port, '/callback?code=x&state=state-1')).rejects.toThrow();
  });

  it('can be cancelled', async () => {
    const { flow, port } = await open();
    const outcome = flow.expect('state-1');
    flow.cancel();
    await expect(outcome).resolves.toEqual({ status: 'cancelled' });
    await expect(call(port, '/callback?code=x&state=state-1')).rejects.toThrow();
  });
});

describe('the callback page', () => {
  it('loads nothing from anywhere', () => {
    for (const succeeded of [true, false]) {
      const page = callbackPage(DEFAULT_PAGE_TEXT, succeeded);
      expect(page).not.toMatch(/<(script|link|img|iframe|object|embed|form|base)\b/i);
      expect(page).not.toMatch(/\b(src|href|action|srcset)\s*=/i);
      expect(page).not.toMatch(/url\(|@import|https?:\/\//i);
    }
    expect(CALLBACK_PAGE_HEADERS['Content-Security-Policy']).toMatch(/^default-src 'none'; style-src 'unsafe-inline';/);
  });

  it('escapes the text it is given', () => {
    const page = callbackPage({ ...DEFAULT_PAGE_TEXT, successTitle: '<script>alert(1)</script>' }, true);
    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;script&gt;');
  });

  it('falls back to English for text it cannot use', () => {
    expect(readPageText(null)).toEqual(DEFAULT_PAGE_TEXT);
    expect(readPageText({ lang: 'en"><script>', successTitle: '', failureBody: 'x'.repeat(301) })).toEqual(DEFAULT_PAGE_TEXT);
    expect(readPageText({ lang: 'nl', successTitle: 'Je bent ingelogd' })).toMatchObject({
      lang: 'nl',
      successTitle: 'Je bent ingelogd',
      failureTitle: DEFAULT_PAGE_TEXT.failureTitle,
    });
  });
});

describe('the authorization request', () => {
  const redirect = 'http://127.0.0.1:53123/callback';

  it('takes the code flow with PKCE S256 back to this listener', () => {
    expect(checkAuthorizationRequest(authorizeUrl(redirect), redirect)).toEqual({ state: 'state-1' });
    // A provider on this machine (local development).
    expect(
      checkAuthorizationRequest(authorizeUrl(redirect).replace('https://auth.example.eu', 'http://localhost:8080'), redirect),
    ).toEqual({ state: 'state-1' });
  });

  it('refuses anything else', () => {
    const refused = [
      authorizeUrl('http://127.0.0.1:1/callback'),
      authorizeUrl(redirect, { redirect_uri: null }),
      authorizeUrl(redirect, { response_type: 'token' }),
      authorizeUrl(redirect, { code_challenge_method: 'plain' }),
      authorizeUrl(redirect, { code_challenge: null }),
      authorizeUrl(redirect, { state: null }),
      authorizeUrl(redirect, { client_id: null }),
      authorizeUrl(redirect).replace('https://', 'http://'),
      authorizeUrl(redirect).replace('https://', 'https://user:pass@'),
      authorizeUrl(redirect).replace('https://auth.example.eu', 'javascript:alert(1)//'),
      'not a url',
    ];
    for (const url of refused) expect(checkAuthorizationRequest(url, redirect), url).toBeNull();
  });
});
