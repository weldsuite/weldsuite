import { describe, it, expect } from 'vitest';
import {
  buildMoneybirdAuthorizeUrl,
  exchangeMoneybirdCode,
  moneybirdRedirectUri,
  MONEYBIRD_CALLBACK_PATH,
  MONEYBIRD_SCOPES,
} from './auth';

describe('Moneybird OAuth helpers', () => {
  it('builds the authorize URL with required scopes', () => {
    const url = buildMoneybirdAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'https://app.weldsuite.org/weldconnect/connectors/callback',
      state: 'st_1',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://moneybird.com/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe('st_1');
    expect(parsed.searchParams.get('scope')).toBe(MONEYBIRD_SCOPES.join(' '));
  });

  it('builds the platform callback redirect URI', () => {
    expect(moneybirdRedirectUri('https://app.weldsuite.org/')).toBe(
      `https://app.weldsuite.org${MONEYBIRD_CALLBACK_PATH}`,
    );
  });

  it('exchanges an authorization code for tokens', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? '');
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=abc');
      return new Response(
        JSON.stringify({ access_token: 'at_1', refresh_token: 'rt_1', scope: 'sales_invoices' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const tokens = await exchangeMoneybirdCode({
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'abc',
      redirectUri: 'https://app.weldsuite.org/weldconnect/connectors/callback',
      fetchImpl,
    });
    expect(tokens).toEqual({ accessToken: 'at_1', refreshToken: 'rt_1', scope: 'sales_invoices' });
  });
});
