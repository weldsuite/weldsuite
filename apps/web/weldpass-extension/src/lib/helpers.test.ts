import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { createPasswordsApi } from './api';
import { errorMessageKey } from './errors';
import { t } from './i18n';
import { RemoteError } from './messaging';
import { blockedMessageKey, fillMessageKey } from './messages';
import { filterItems } from './search';
import { pageUrlForSaving, safeExternalUrl } from './urls';

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
    expect(errorMessageKey(new RemoteError('api', 401))).toBe('errorSession');
    expect(errorMessageKey(new RemoteError('api', 403))).toBe('errorForbidden');
    expect(errorMessageKey(new RemoteError('api', 404))).toBe('errorNotFound');
    expect(errorMessageKey(new RemoteError('api', 500))).toBe('errorGeneric');
    expect(errorMessageKey(new RemoteError('network'))).toBe('errorNetwork');
    expect(errorMessageKey(new RemoteError('signed-out'))).toBe('errorSession');
    expect(errorMessageKey(new RemoteError('no-workspace'))).toBe('pickWorkspaceTitle');
    expect(errorMessageKey(new Error('Server said: secret detail'))).toBe('errorGeneric');
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

  it('calls the server with the token, the workspace and the extension client header', async () => {
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = createPasswordsApi({
      apiOrigin: 'https://app.weldsuite.eu',
      getToken: async () => 'access.jwt',
      getWorkspaceId: () => 'ws_123',
    });
    await api.matchItems('https://example.com');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://app.weldsuite.eu/api/weldpass/items/match?url=https%3A%2F%2Fexample.com');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer access.jwt',
      'X-WeldPass-Client': 'extension',
      'X-Weld-Workspace': 'ws_123',
    });
  });

  it('sends no workspace header in claim mode (the token names the workspace)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createPasswordsApi({ apiOrigin: 'https://eu.example', getToken: async () => 't', getWorkspaceId: () => null });
    await api.listVaults();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain('X-Weld-Workspace');
  });

  it('does not call the API without a token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const api = createPasswordsApi({ apiOrigin: 'https://eu.example', getToken: async () => null, getWorkspaceId: () => null });
    await expect(api.listItems()).rejects.toThrow('Authentication required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
