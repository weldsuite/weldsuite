import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '@weldsuite/api-client';
import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { createPasswordsApi } from './api';
import { normaliseBaseUrl, readConfig } from './config';
import { errorMessageKey } from './errors';
import { t } from './i18n';
import { blockedMessageKey, fillMessageKey } from './messages';
import { filterItems } from './search';
import { pageUrlForSaving, safeExternalUrl } from './urls';

describe('readConfig', () => {
  const env = {
    VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k',
    VITE_SYNC_HOST: 'https://app.example.com/',
    VITE_API_URL: 'https://app-api.example.com',
  };

  it('reads a complete env and trims trailing slashes', () => {
    expect(readConfig(env)).toEqual({
      ok: true,
      config: {
        publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
        syncHost: 'https://app.example.com',
        apiUrl: 'https://app-api.example.com',
        appUrl: 'https://app.example.com',
      },
    });
  });

  it('uses VITE_APP_URL for the web app when the sync host is something else', () => {
    const result = readConfig({
      ...env,
      VITE_SYNC_HOST: 'https://clerk.example.com',
      VITE_APP_URL: 'https://app.example.com',
    });
    expect(result).toMatchObject({
      ok: true,
      config: { syncHost: 'https://clerk.example.com', appUrl: 'https://app.example.com' },
    });
  });

  it('names what is missing instead of throwing', () => {
    expect(readConfig({})).toEqual({
      ok: false,
      missing: ['VITE_CLERK_PUBLISHABLE_KEY', 'VITE_SYNC_HOST', 'VITE_API_URL'],
    });
    expect(readConfig({ ...env, VITE_API_URL: 'ftp://nope' })).toEqual({
      ok: false,
      missing: ['VITE_API_URL'],
    });
    expect(readConfig({ ...env, VITE_CLERK_PUBLISHABLE_KEY: 'sk_live_oops' })).toEqual({
      ok: false,
      missing: ['VITE_CLERK_PUBLISHABLE_KEY'],
    });
  });

  it('normalises base URLs', () => {
    expect(normaliseBaseUrl(' http://localhost:8789/ ')).toBe('http://localhost:8789');
    expect(normaliseBaseUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseBaseUrl(undefined)).toBeNull();
  });
});

describe('safeExternalUrl', () => {
  it('opens http(s) addresses, adding https when the scheme is missing', () => {
    expect(safeExternalUrl('https://example.com/login')).toBe('https://example.com/login');
    expect(safeExternalUrl('example.com/login')).toBe('https://example.com/login');
    expect(safeExternalUrl('localhost:3000')).toBe('https://localhost:3000/');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'chrome://settings', '', null])(
    'refuses %s',
    (value) => {
      expect(safeExternalUrl(value)).toBeNull();
    },
  );
});

describe('pageUrlForSaving', () => {
  it('drops the query string and fragment', () => {
    expect(pageUrlForSaving('https://example.com/reset?token=secret#step-2')).toBe(
      'https://example.com/reset',
    );
  });

  it('returns null for pages that are not web pages', () => {
    expect(pageUrlForSaving('chrome://extensions')).toBeNull();
    expect(pageUrlForSaving(null)).toBeNull();
  });
});

describe('filterItems', () => {
  const make = (title: string, subtitle: string | null, host: string | null) =>
    ({ id: title, title, subtitle, host }) as WeldPassItem;
  const items = [
    make('GitHub', 'ada@example.com', 'github.com'),
    make('GitLab', 'grace', 'gitlab.com'),
    make('Bank', null, null),
  ];

  it('returns everything for an empty query', () => {
    expect(filterItems(items, '  ')).toEqual(items);
  });

  it('matches every word against title, username and host, ignoring case', () => {
    expect(filterItems(items, 'GIT').map((item) => item.title)).toEqual(['GitHub', 'GitLab']);
    expect(filterItems(items, 'git ada').map((item) => item.title)).toEqual(['GitHub']);
    expect(filterItems(items, 'gitlab.com').map((item) => item.title)).toEqual(['GitLab']);
    expect(filterItems(items, 'nothing')).toEqual([]);
  });
});

describe('messages', () => {
  it('describes what a fill did', () => {
    expect(fillMessageKey({ ok: true, username: true, password: true })).toBe('filledBoth');
    expect(fillMessageKey({ ok: true, username: false, password: true })).toBe('filledPassword');
    expect(fillMessageKey({ ok: true, username: true, password: false })).toBe('filledUsername');
  });

  it('describes why a fill did not happen', () => {
    expect(fillMessageKey({ ok: false, reason: 'host-mismatch' })).toBe('fillHostMismatch');
    expect(fillMessageKey({ ok: false, reason: 'insecure-page' })).toBe('fillInsecure');
    expect(fillMessageKey({ ok: false, reason: 'page-changed' })).toBe('fillPageChanged');
    expect(fillMessageKey({ ok: false, reason: 'not-a-login' })).toBe('noPassword');
    expect(blockedMessageKey('injection-failed')).toBe('fillFailed');
  });

  it('maps API failures to messages without echoing server text', () => {
    expect(errorMessageKey(new ApiError('nope', 401))).toBe('errorSession');
    expect(errorMessageKey(new ApiError('nope', 403))).toBe('errorForbidden');
    expect(errorMessageKey(new ApiError('nope', 404))).toBe('errorNotFound');
    expect(errorMessageKey(new ApiError('nope', 500))).toBe('errorGeneric');
    expect(errorMessageKey(new NetworkError())).toBe('errorNetwork');
    expect(errorMessageKey(new Error('Authentication required'))).toBe('errorSession');
    expect(errorMessageKey('weird')).toBe('errorGeneric');
  });

  it('falls back to the English messages outside an extension', () => {
    expect(t('fill')).toBe('Fill');
    expect(t('forHost', 'example.com')).toBe('For example.com');
    expect(t('totpCopied', 12)).toBe('2FA code copied. Valid for 12 more seconds.');
  });
});

describe('createPasswordsApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls app-api with the Clerk token and the extension client header', async () => {
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = createPasswordsApi({
      apiUrl: 'https://app-api.example.com',
      getToken: async () => 'session.jwt',
    });
    await api.matchItems('https://example.com');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://app-api.example.com/api/weldpass/items/match?url=https%3A%2F%2Fexample.com',
    );
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer session.jwt',
      'X-WeldPass-Client': 'extension',
    });
  });

  it('does not call the API without a token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const api = createPasswordsApi({ apiUrl: 'https://app-api.example.com', getToken: async () => null });
    await expect(api.listItems()).rejects.toThrow('Authentication required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
