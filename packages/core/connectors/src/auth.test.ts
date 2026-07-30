import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, resolveClientCredentials, signState, verifyState } from './auth';

const SECRET = 'test-state-secret';

const BASE_STATE = {
  workspaceId: 'org_123',
  connectorId: 'moneybird',
  userId: 'user_123',
  connectionId: 'ccn_123',
};

describe('signState / verifyState', () => {
  it('round-trips a payload', async () => {
    const state = await signState(BASE_STATE, SECRET);
    expect(await verifyState(state, SECRET)).toMatchObject(BASE_STATE);
  });

  it('rejects a payload signed with a different secret', async () => {
    const state = await signState(BASE_STATE, SECRET);
    expect(await verifyState(state, 'other-secret')).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    // The attack this prevents: swapping the workspace id so the callback binds
    // the connection to a workspace the user does not belong to.
    const state = await signState(BASE_STATE, SECRET);
    const [body, signature] = state.split('.');
    const forged = { ...BASE_STATE, workspaceId: 'org_victim', expiresAt: Date.now() + 60_000 };
    const forgedBody = btoa(JSON.stringify(forged))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(body).not.toBe(forgedBody);
    expect(await verifyState(`${forgedBody}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects an expired state', async () => {
    const state = await signState({ ...BASE_STATE, expiresAt: Date.now() - 1 }, SECRET);
    expect(await verifyState(state, SECRET)).toBeNull();
  });

  it('rejects malformed input rather than throwing', async () => {
    // This runs on a public endpoint, so anything can be posted at it.
    for (const bad of ['', 'nodot', 'a.b.c', '!!!.!!!', 'eyJ9.zzz']) {
      expect(await verifyState(bad, SECRET)).toBeNull();
    }
  });

  it('rejects a validly signed state that is missing required fields', async () => {
    const state = await signState(
      { ...BASE_STATE, connectionId: '' } as never,
      SECRET,
    );
    expect(await verifyState(state, SECRET)).toBeNull();
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds a standard authorization-code URL', () => {
    const url = new URL(
      buildAuthorizeUrl({
        config: {
          authorizeUrl: 'https://moneybird.com/oauth/authorize',
          tokenUrl: 'https://moneybird.com/oauth/token',
        },
        clientId: 'client-1',
        redirectUri: 'https://app-api.example/public/connectors/oauth/callback',
        scopes: ['sales_invoices', 'settings'],
        state: 'signed-state',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://moneybird.com/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('scope')).toBe('sales_invoices settings');
    expect(url.searchParams.get('state')).toBe('signed-state');
  });

  it('honours a provider-specific scope separator and extra params', () => {
    // Where provider quirks belong — not in a branch inside the shared flow.
    const url = new URL(
      buildAuthorizeUrl({
        config: {
          authorizeUrl: 'https://provider.example/authorize',
          tokenUrl: 'https://provider.example/token',
          scopeSeparator: ',',
          extraAuthorizeParams: { access_type: 'offline' },
        },
        clientId: 'c',
        redirectUri: 'https://example.test/cb',
        scopes: ['a', 'b'],
        state: 's',
      }),
    );

    expect(url.searchParams.get('scope')).toBe('a,b');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('omits scope entirely when none are requested', () => {
    const url = new URL(
      buildAuthorizeUrl({
        config: { authorizeUrl: 'https://p.example/a', tokenUrl: 'https://p.example/t' },
        clientId: 'c',
        redirectUri: 'https://example.test/cb',
        scopes: [],
        state: 's',
      }),
    );
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('resolveClientCredentials', () => {
  it('reads the ${CONNECTOR_ID}_CLIENT_ID convention', () => {
    expect(
      resolveClientCredentials('moneybird', {
        MONEYBIRD_CLIENT_ID: 'id',
        MONEYBIRD_CLIENT_SECRET: 'secret',
      }),
    ).toEqual({ clientId: 'id', clientSecret: 'secret' });
  });

  it('maps hyphens in a connector id to underscores', () => {
    expect(
      resolveClientCredentials('google-calendar', {
        GOOGLE_CALENDAR_CLIENT_ID: 'id',
        GOOGLE_CALENDAR_CLIENT_SECRET: 'secret',
      }),
    ).toEqual({ clientId: 'id', clientSecret: 'secret' });
  });

  it('returns null when either half is missing or empty', () => {
    // Half-configured must read as unconfigured; an empty client id would
    // otherwise reach the provider and fail as an opaque error.
    expect(resolveClientCredentials('moneybird', { MONEYBIRD_CLIENT_ID: 'id' })).toBeNull();
    expect(
      resolveClientCredentials('moneybird', {
        MONEYBIRD_CLIENT_ID: '',
        MONEYBIRD_CLIENT_SECRET: 'secret',
      }),
    ).toBeNull();
    expect(resolveClientCredentials('moneybird', {})).toBeNull();
  });
});
