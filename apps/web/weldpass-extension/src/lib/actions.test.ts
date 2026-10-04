import { describe, expect, it, vi } from 'vitest';
import type {
  WeldPassItem,
  WeldPassRevealedItem,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import type { PageCommand, PageResult } from '../page/page-agent';
import { fillLogin, fillNewPassword, readLoginFromPage, revealPassword, type PagePort } from './actions';

const item: WeldPassItem = {
  id: 'itm_1',
  vaultId: 'vlt_1',
  type: 'login',
  title: 'Example',
  subtitle: 'ada',
  url: 'https://example.com/login',
  host: 'example.com',
  hasTotp: false,
  passwordChangedAt: null,
  version: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function revealed(overrides: Partial<WeldPassRevealedItem> = {}): WeldPassRevealedItem {
  return {
    ...item,
    fields: { username: 'ada@example.com', password: 's3cret', totp: '', notes: '' },
    ...overrides,
  };
}

function fakeApi(reveal: WeldPassRevealedItem = revealed()) {
  return { revealItem: vi.fn(async () => ({ data: reveal })) };
}

/** A page that answers the probe and records every command it is sent. */
function fakePage(options: {
  urls: Array<string | null>;
  probe?: PageResult;
  fill?: PageResult;
  other?: PageResult;
}): PagePort & { commands: PageCommand[] } {
  const urls = [...options.urls];
  const commands: PageCommand[] = [];
  return {
    commands,
    async currentUrl() {
      // The last URL repeats, so a test only lists the changes.
      return urls.length > 1 ? (urls.shift() ?? null) : (urls[0] ?? null);
    },
    async run(_tabId, command) {
      commands.push(command);
      if (command.kind === 'probe') {
        return options.probe ?? { status: 'probed', hasUsername: true, hasPassword: true };
      }
      if (command.kind === 'fill-login') {
        return (
          options.fill ?? {
            status: 'filled',
            username: command.username !== '',
            password: command.password !== null,
            passwordFields: command.password === null ? 0 : 1,
          }
        );
      }
      return options.other ?? { status: 'no-fields' };
    },
  };
}

describe('fillLogin', () => {
  it('reveals the password and fills it into the matching page', async () => {
    const api = fakeApi();
    const page = fakePage({ urls: ['https://example.com/login'] });

    await expect(fillLogin(api, page, item, 7)).resolves.toEqual({
      ok: true,
      username: true,
      password: true,
    });
    expect(api.revealItem).toHaveBeenCalledExactlyOnceWith('vlt_1', 'itm_1');
    expect(page.commands).toEqual([
      { kind: 'probe', expectedOrigin: 'https://example.com' },
      {
        kind: 'fill-login',
        expectedOrigin: 'https://example.com',
        username: 'ada@example.com',
        password: 's3cret',
      },
    ]);
  });

  it.each([
    ['another site', 'https://evil.example/login', 'host-mismatch'],
    ['a look-alike host', 'https://example.com.evil.example/', 'host-mismatch'],
    ['plain http', 'http://example.com/login', 'insecure-page'],
    ['a browser page', 'chrome://settings/passwords', 'unsupported-page'],
    ['a tab with no URL', null, 'no-page'],
  ])('never reveals or injects on %s', async (_name, url, reason) => {
    const api = fakeApi();
    const page = fakePage({ urls: [url] });

    await expect(fillLogin(api, page, item, 7)).resolves.toEqual({ ok: false, reason });
    expect(api.revealItem).not.toHaveBeenCalled();
    expect(page.commands).toEqual([]);
  });

  it('judges the tab as it is now, not the item list the popup drew', async () => {
    // The popup showed a Fill button for example.com; the tab has since moved on.
    const api = fakeApi();
    const page = fakePage({ urls: ['https://phish.example/'] });

    const outcome = await fillLogin(api, page, item, 7);
    expect(outcome).toEqual({ ok: false, reason: 'host-mismatch' });
    expect(api.revealItem).not.toHaveBeenCalled();
  });

  it('does not fill when the tab navigates away while the password is being fetched', async () => {
    const api = fakeApi();
    const page = fakePage({ urls: ['https://example.com/login', 'https://evil.example/'] });

    await expect(fillLogin(api, page, item, 7)).resolves.toEqual({
      ok: false,
      reason: 'host-mismatch',
    });
    expect(page.commands.map((command) => command.kind)).toEqual(['probe']);
  });

  it('does not fill when the tab moves to another origin of the same site meanwhile', async () => {
    const api = fakeApi();
    const page = fakePage({ urls: ['https://example.com/login', 'https://other.example.com/'] });

    await expect(fillLogin(api, page, item, 7)).resolves.toEqual({
      ok: false,
      reason: 'page-changed',
    });
    expect(page.commands.map((command) => command.kind)).toEqual(['probe']);
  });

  it('does not fill when the item now belongs to another host on the server', async () => {
    const api = fakeApi(revealed({ host: 'elsewhere.example', url: 'https://elsewhere.example' }));
    const page = fakePage({ urls: ['https://example.com/login'] });

    await expect(fillLogin(api, page, item, 7)).resolves.toEqual({
      ok: false,
      reason: 'host-mismatch',
    });
    expect(page.commands.map((command) => command.kind)).toEqual(['probe']);
  });

  it('reports the page refusing the origin at injection time', async () => {
    const api = fakeApi();
    const page = fakePage({ urls: ['https://example.com/'], fill: { status: 'origin-mismatch' } });

    await expect(fillLogin(api, page, item, 7)).resolves.toEqual({
      ok: false,
      reason: 'page-changed',
    });
  });

  it('fills the username without revealing anything on a username-only step', async () => {
    const api = fakeApi();
    const page = fakePage({
      urls: ['https://example.com/login'],
      probe: { status: 'probed', hasUsername: true, hasPassword: false },
    });

    await expect(fillLogin(api, page, item, 7)).resolves.toEqual({
      ok: true,
      username: true,
      password: false,
    });
    expect(api.revealItem).not.toHaveBeenCalled();
    expect(page.commands[1]).toEqual({
      kind: 'fill-login',
      expectedOrigin: 'https://example.com',
      username: 'ada',
      password: null,
    });
  });

  it('does not reveal when the page has no login form', async () => {
    const api = fakeApi();
    const page = fakePage({
      urls: ['https://example.com/'],
      probe: { status: 'probed', hasUsername: false, hasPassword: false },
    });

    await expect(fillLogin(api, page, item, 7)).resolves.toEqual({ ok: false, reason: 'no-fields' });
    expect(api.revealItem).not.toHaveBeenCalled();
  });

  it('reports a page the browser will not let the extension into', async () => {
    const api = fakeApi();
    const page: PagePort = {
      currentUrl: async () => 'https://example.com/',
      run: async () => {
        throw new Error('Cannot access contents of the page');
      },
    };

    await expect(fillLogin(api, page, item, 7)).resolves.toEqual({
      ok: false,
      reason: 'injection-failed',
    });
    expect(api.revealItem).not.toHaveBeenCalled();
  });

  it('refuses notes and cards', async () => {
    const api = fakeApi();
    const page = fakePage({ urls: ['https://example.com/'] });

    await expect(fillLogin(api, page, { ...item, type: 'note' }, 7)).resolves.toEqual({
      ok: false,
      reason: 'not-a-login',
    });
    expect(api.revealItem).not.toHaveBeenCalled();
  });

  it('lets API failures through to the caller', async () => {
    const api = { revealItem: vi.fn(async () => Promise.reject(new Error('boom'))) };
    const page = fakePage({ urls: ['https://example.com/'] });

    await expect(fillLogin(api, page, item, 7)).rejects.toThrow('boom');
    expect(page.commands.map((command) => command.kind)).toEqual(['probe']);
  });
});

describe('revealPassword', () => {
  it('returns the password of a login', async () => {
    await expect(revealPassword(fakeApi(), item)).resolves.toBe('s3cret');
  });

  it('returns null for an item without one', async () => {
    const note = revealed({ type: 'note', fields: { content: 'hello' } });
    await expect(revealPassword(fakeApi(note), item)).resolves.toBeNull();

    const empty = revealed({ fields: { username: 'ada', password: '', totp: '', notes: '' } });
    await expect(revealPassword(fakeApi(empty), item)).resolves.toBeNull();
  });
});

describe('readLoginFromPage', () => {
  it('reads the form of an allowed page', async () => {
    const page = fakePage({
      urls: ['https://example.com/login?token=abc'],
      other: { status: 'read', username: 'ada', password: 'pw', hasPasswordField: true },
    });

    await expect(readLoginFromPage(page, 7)).resolves.toEqual({
      ok: true,
      username: 'ada',
      password: 'pw',
      hasPasswordField: true,
    });
    expect(page.commands).toEqual([{ kind: 'read-login', expectedOrigin: 'https://example.com' }]);
  });

  it('does not inject into pages it may not touch', async () => {
    const page = fakePage({ urls: ['http://example.com/login'] });
    await expect(readLoginFromPage(page, 7)).resolves.toEqual({ ok: false, reason: 'insecure-page' });
    expect(page.commands).toEqual([]);
  });
});

describe('fillNewPassword', () => {
  it('fills the generated password and reports how many fields took it', async () => {
    const page = fakePage({
      urls: ['https://example.com/signup'],
      other: { status: 'filled', username: false, password: true, passwordFields: 2 },
    });

    await expect(fillNewPassword(page, 7, 'Gen3rated!')).resolves.toEqual({ ok: true, fields: 2 });
    expect(page.commands).toEqual([
      { kind: 'fill-new-password', expectedOrigin: 'https://example.com', password: 'Gen3rated!' },
    ]);
  });

  it('does not inject into pages it may not touch', async () => {
    const page = fakePage({ urls: ['chrome://newtab'] });
    await expect(fillNewPassword(page, 7, 'Gen3rated!')).resolves.toEqual({
      ok: false,
      reason: 'unsupported-page',
    });
    expect(page.commands).toEqual([]);
  });

  it('reports a page with no password field', async () => {
    const page = fakePage({ urls: ['https://example.com/'] });
    await expect(fillNewPassword(page, 7, 'Gen3rated!')).resolves.toEqual({
      ok: false,
      reason: 'no-fields',
    });
  });
});
