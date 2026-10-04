import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import nl from '../locales/nl.json';
import {
  buildManifest,
  frontendApiFromPublishableKey,
  hostPermission,
  hostPermissions,
  type LocaleMessages,
} from './manifest';

const pk = (host: string, kind = 'live') => `pk_${kind}_${btoa(`${host}$`)}`;

const env = {
  publishableKey: pk('clerk.weldsuite.org'),
  syncHost: 'https://app.weldsuite.org',
  apiUrl: 'https://app-api.weldsuite.org',
};

describe('frontendApiFromPublishableKey', () => {
  it('decodes the Frontend API host from a publishable key', () => {
    expect(frontendApiFromPublishableKey(pk('clerk.weldsuite.org'))).toBe(
      'https://clerk.weldsuite.org',
    );
    expect(frontendApiFromPublishableKey(pk('quick-fox-12.clerk.accounts.dev', 'test'))).toBe(
      'https://quick-fox-12.clerk.accounts.dev',
    );
  });

  it.each([undefined, '', 'sk_live_abc', 'pk_live_!!!', `pk_live_${btoa('no-dollar.example.com')}`, `pk_live_${btoa('*$')}`])(
    'returns null for %s',
    (key) => {
      expect(frontendApiFromPublishableKey(key)).toBeNull();
    },
  );
});

describe('hostPermission', () => {
  it('builds a match pattern for exactly one host', () => {
    expect(hostPermission('https://app-api.weldsuite.org')).toBe('https://app-api.weldsuite.org/*');
    expect(hostPermission('http://localhost:8789/api')).toBe('http://localhost/*');
  });

  it.each([undefined, '', 'not a url', 'ftp://example.com', 'chrome://extensions', '<all_urls>', '*://*/*'])(
    'returns null for %s',
    (value) => {
      expect(hostPermission(value)).toBeNull();
    },
  );
});

describe('buildManifest', () => {
  const manifest = buildManifest({ version: '1.2.3', env, hasIcons: true });

  it('is a Manifest V3 action popup with native i18n', () => {
    expect(manifest).toMatchObject({
      manifest_version: 3,
      version: '1.2.3',
      default_locale: 'en',
      name: '__MSG_extName__',
      action: { default_popup: 'popup.html' },
    });
  });

  it('asks for exactly the permissions the README justifies', () => {
    expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage', 'cookies']);
  });

  it('has host access to the API, the sync host and the Clerk Frontend API only', () => {
    expect(manifest.host_permissions).toEqual([
      'https://app-api.weldsuite.org/*',
      'https://app.weldsuite.org/*',
      'https://clerk.weldsuite.org/*',
    ]);
  });

  it('does not repeat a host that plays two roles', () => {
    expect(hostPermissions({ ...env, syncHost: 'https://clerk.weldsuite.org' })).toEqual([
      'https://app-api.weldsuite.org/*',
      'https://clerk.weldsuite.org/*',
    ]);
  });

  it('never has a content script, a background worker or a broad host pattern', () => {
    const json = JSON.stringify(
      buildManifest({
        version: '1.0.0',
        env: { ...env, syncHost: '<all_urls>', apiUrl: '*://*/*' },
        hasIcons: true,
      }),
    );
    expect(json).not.toContain('<all_urls>');
    expect(json).not.toContain('*://');
    expect(json).not.toContain('content_scripts');
    expect(json).not.toContain('"background"');
    expect(json).not.toContain('"tabs"');
    expect(json).not.toContain('unsafe-');
  });

  it('builds without any configuration', () => {
    const bare = buildManifest({ version: '1.0.0', env: {}, hasIcons: false });
    expect(bare.host_permissions).toEqual([]);
    expect(bare.icons).toBeUndefined();
    expect(bare.key).toBeUndefined();
  });

  it('pins the extension ID when a key is configured', () => {
    expect(
      buildManifest({ version: '1.0.0', env: { ...env, extensionKey: ' MIIB ' }, hasIcons: false }).key,
    ).toBe('MIIB');
  });

  it('suggests a shortcut for opening the popup', () => {
    expect(manifest.commands._execute_action.suggested_key.default).toMatch(/^(Ctrl|Alt)\+/);
  });
});

describe('locales', () => {
  const locales: Record<string, LocaleMessages> = { en, nl };
  const placeholders = (message: string) => [...message.matchAll(/\$\d/g)].map(String).sort();

  it('has the same messages in English and Dutch', () => {
    expect(Object.keys(nl).sort()).toEqual(Object.keys(en).sort());
  });

  it('uses the same placeholders in every language', () => {
    for (const key of Object.keys(en)) {
      expect(placeholders(locales.nl[key].message), key).toEqual(placeholders(locales.en[key].message));
    }
  });

  it('has the messages the manifest refers to, with names Chrome accepts', () => {
    for (const messages of Object.values(locales)) {
      for (const key of ['extName', 'extDescription', 'actionTitle']) {
        expect(messages[key].message).not.toBe('');
      }
      const names = Object.keys(messages);
      for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_@]+$/);
      // Chrome treats message names case-insensitively.
      expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
      for (const { message } of Object.values(messages)) expect(message.trim()).not.toBe('');
    }
  });

  it('keeps the store description within Chrome\'s 132 characters', () => {
    for (const messages of Object.values(locales)) {
      expect(messages.extDescription.message.length).toBeLessThanOrEqual(132);
    }
  });

  it('is actually translated', () => {
    const same = Object.keys(en).filter((key) => locales.en[key].message === locales.nl[key].message);
    // Brand names and words Dutch shares with English.
    expect(same.sort()).toEqual(['actionTitle', 'extName', 'fieldUrl', 'tabGenerator', 'tabLogins']);
  });
});
