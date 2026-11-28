import { describe, expect, it, vi } from 'vitest';
import {
  PENDING_COOKIE,
  handleSignatureCallback,
  pendingCookie,
  readPendingCookie,
  redirectOf,
  type SignatureCallbackDeps,
} from './portal-callback';

const callback = (query: string) => new URL(`https://sign.example.eu/signature-callback?${query}`);
const cookie = (token = 'tok_1', state = 'st_1') => pendingCookie({ token, state }, true).split(';')[0]!;

function deps(finish: () => Response, session: string | undefined = 'sess') {
  return {
    sessionFor: vi.fn(async () => session),
    finish: vi.fn(async () => finish()),
    cancel: vi.fn(async () => new Response(null, { status: 204 })),
  } satisfies SignatureCallbackDeps;
}

describe('pending cookie', () => {
  it('is httpOnly, Lax, short-lived and secure over https', () => {
    const value = pendingCookie({ token: 'tok_1', state: 'st_1' }, true);
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Lax');
    expect(value).toContain('Max-Age=1800');
    expect(value).toContain('Secure');
    expect(pendingCookie({ token: 't', state: 's' }, false)).not.toContain('Secure');
  });

  it('reads back what it stored, and nothing from a broken value', () => {
    expect(readPendingCookie(`a=b; ${cookie()}; c=d`)).toEqual({ token: 'tok_1', state: 'st_1' });
    expect(readPendingCookie(`${PENDING_COOKIE}=%7Bnope`)).toBeNull();
    expect(readPendingCookie(null)).toBeNull();
  });
});

describe('handleSignatureCallback', () => {
  it('finishes with the link session and sends the signer back to their link', async () => {
    const d = deps(() => Response.json({ data: { mode: 'completed' } }));
    const result = await handleSignatureCallback(callback('code=abc&state=st_1'), cookie(), d);
    expect(d.sessionFor).toHaveBeenCalledWith('tok_1');
    expect(d.finish).toHaveBeenCalledWith('sess', { state: 'st_1', code: 'abc' });
    expect(result.location).toBe('/r/tok_1');
    expect(result.setCookie).toContain('Max-Age=0');
  });

  it('follows a second round trip and keeps the link with the new state', async () => {
    const d = deps(() => Response.json({ data: { redirectUrl: 'https://qtsp.example/authorize?x=1', state: 'st_2' } }));
    const result = await handleSignatureCallback(callback('code=abc&state=st_1'), cookie(), d);
    expect(result.location).toBe('https://qtsp.example/authorize?x=1');
    expect(readPendingCookie(result.setCookie.split(';')[0])).toEqual({ token: 'tok_1', state: 'st_2' });
    expect(result.setCookie).toContain('Max-Age=1800');
  });

  it('accepts a dev provider that redirects straight back to the callback', async () => {
    const back = 'http://localhost:3023/signature-callback?code=dev&state=st_2';
    const d = deps(() => Response.json({ data: { redirectUrl: back, state: 'st_2' } }));
    const result = await handleSignatureCallback(callback('code=abc&state=st_1'), cookie(), d);
    expect(result.location).toBe(back);
  });

  it('does not follow a redirect that is not http(s)', async () => {
    const d = deps(() => Response.json({ data: { redirectUrl: 'javascript:alert(1)', state: 'st_2' } }));
    const result = await handleSignatureCallback(callback('code=abc&state=st_1'), cookie(), d);
    expect(result.location).toBe('/r/tok_1');
  });

  it('ignores a callback whose state is not the one this browser started', async () => {
    const d = deps(() => Response.json({ data: {} }));
    const result = await handleSignatureCallback(callback('code=abc&state=other'), cookie(), d);
    expect(d.finish).not.toHaveBeenCalled();
    expect(result.location).toBe('/');
    expect(result.setCookie).toContain('Max-Age=0');
  });

  it('ignores a callback without a cookie', async () => {
    const d = deps(() => Response.json({ data: {} }));
    const result = await handleSignatureCallback(callback('code=abc&state=st_1'), undefined, d);
    expect(d.finish).not.toHaveBeenCalled();
    expect(result.location).toBe('/');
  });

  it('returns the signer to their link to try again when signing failed', async () => {
    const d = deps(() => Response.json({ error: { code: 'SIGNATURE_FAILED', message: 'x' } }, { status: 400 }));
    const result = await handleSignatureCallback(callback('code=abc&state=st_1'), cookie(), d);
    expect(result.location).toBe('/r/tok_1?signature=failed');
  });

  it('tells the backend when the signer declined at the provider', async () => {
    const d = deps(() => Response.json({ data: {} }));
    const result = await handleSignatureCallback(callback('error=access_denied&state=st_1'), cookie(), d);
    expect(d.cancel).toHaveBeenCalledWith('sess', { state: 'st_1' });
    expect(d.finish).not.toHaveBeenCalled();
    expect(result.location).toBe('/r/tok_1?signature=cancelled');
  });

  it('passes another provider error on to finish', async () => {
    const d = deps(() => Response.json({ error: { code: 'SIGNATURE_FAILED', message: 'x' } }, { status: 400 }));
    const result = await handleSignatureCallback(
      callback('error=server_error&error_description=Boom&state=st_1'),
      cookie(),
      d,
    );
    expect(d.finish).toHaveBeenCalledWith('sess', { state: 'st_1', error: 'server_error', errorDescription: 'Boom' });
    expect(result.location).toBe('/r/tok_1?signature=failed');
  });

  it('fails softly when the backend cannot be reached', async () => {
    const d = deps(() => Response.json({}));
    d.finish.mockRejectedValue(new Error('down'));
    const result = await handleSignatureCallback(callback('code=abc&state=st_1'), cookie(), d);
    expect(result.location).toBe('/r/tok_1?signature=failed');
  });
});

describe('redirectOf', () => {
  it('reads a redirect and leaves the response readable', async () => {
    const res = Response.json({ data: { redirectUrl: 'https://qtsp.example/a', state: 's' } });
    expect(await redirectOf(res)).toEqual({ redirectUrl: 'https://qtsp.example/a', state: 's' });
    expect(((await res.json()) as { data: { state: string } }).data.state).toBe('s');
  });
  it('is null for a signed answer or an error', async () => {
    expect(await redirectOf(Response.json({ data: { mode: 'completed' } }))).toBeNull();
    expect(await redirectOf(Response.json({}, { status: 400 }))).toBeNull();
  });
});
