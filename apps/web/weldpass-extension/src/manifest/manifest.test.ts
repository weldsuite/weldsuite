import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultServerFrom } from '../lib/build-config';
import en from '../locales/en.json';
import nl from '../locales/nl.json';
import { DEVELOPMENT_ID, DEVELOPMENT_KEY } from './dev-key';
import { buildManifest, type LocaleMessages } from './manifest';

const EU = { origin: 'https://app.weldsuite.eu', issuer: 'https://auth.weldsuite.eu' };

function manifestFor(options: Partial<Parameters<typeof buildManifest>[0]> = {}) {
  return buildManifest({ version: '1.2.3', defaultServer: EU, store: true, hasIcons: true, ...options });
}

/** Chrome's id for a public key: SHA-256, first 32 hex digits, 0-f mapped to a-p. */
function extensionId(base64Key: string): string {
  return createHash('sha256')
    .update(Buffer.from(base64Key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .split('')
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join('');
}

describe('buildManifest', () => {
  const manifest = manifestFor();

  it('is a Manifest V3 extension with native i18n', () => {
    expect(manifest).toMatchObject({
      manifest_version: 3,
      version: '1.2.3',
      default_locale: 'en',
      name: '__MSG_extName__',
      action: { default_popup: 'popup.html' },
      options_ui: { page: 'settings.html', open_in_tab: true },
    });
  });

  // ADR PASS-009. A change here is a change to that decision: amend the ADR first.
  it('asks for exactly the permissions PASS-009 allows', () => {
    expect(manifest.permissions).toEqual(['activeTab', 'identity', 'scripting', 'storage']);
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.permissions).not.toContain('cookies');
  });

  it('has host access to the default server and its sign-in server only', () => {
    expect(manifest.host_permissions).toEqual(['https://app.weldsuite.eu/*', 'https://auth.weldsuite.eu/*']);
  });

  it('asks for a self-hosted server at run time, https or localhost only', () => {
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://localhost/*']);
  });

  it('runs one module service worker', () => {
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });

  it('runs one content script, on https pages and localhost, in every frame', () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['https://*/*', 'http://localhost/*'],
        js: ['content.js'],
        all_frames: true,
        run_at: 'document_idle',
      },
    ]);
  });

  it('lets pages frame the inline menu and the save bar only, at a per-session URL', () => {
    expect(manifest.web_accessible_resources).toEqual([
      {
        resources: ['menu.html', 'prompt.html'],
        matches: ['https://*/*', 'http://localhost/*'],
        use_dynamic_url: true,
      },
    ]);
  });

  it('has nothing beyond that: no all-urls, no plain http, no remote code, no external messaging', () => {
    const json = JSON.stringify(manifest);
    expect(json).not.toContain('<all_urls>');
    expect(json).not.toContain('*://');
    expect(json).not.toMatch(/http:\/\/\*/);
    expect(json).not.toContain('unsafe-');
    expect(json).not.toContain('externally_connectable');
    expect(json).not.toContain('"tabs"');
    expect(json).not.toContain('webRequest');
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'action',
        'background',
        'commands',
        'content_scripts',
        'content_security_policy',
        'default_locale',
        'description',
        'icons',
        'manifest_version',
        'minimum_chrome_version',
        'name',
        'optional_host_permissions',
        'options_ui',
        'permissions',
        'host_permissions',
        'short_name',
        'version',
        'web_accessible_resources',
      ].sort(),
    );
    expect(manifest.content_security_policy.extension_pages).toBe("script-src 'self'; object-src 'self'");
  });

  it('grants host access to a development server and its issuer instead', () => {
    const local = manifestFor({
      defaultServer: defaultServerFrom({
        VITE_DEFAULT_SERVER: 'https://app.test.weldsuite.eu',
        VITE_DEFAULT_ISSUER: 'https://auth.test.weldsuite.eu/',
      }),
    });
    expect(local.host_permissions).toEqual(['https://app.test.weldsuite.eu/*', 'https://auth.test.weldsuite.eu/*']);
    // Anything that isn't https (or localhost) falls back to EU.
    expect(defaultServerFrom({ VITE_DEFAULT_SERVER: 'http://evil.example' })).toEqual(EU);
    expect(defaultServerFrom({})).toEqual(EU);
  });

  it('carries no key in a store build, even when one is configured', () => {
    expect(manifestFor({ store: true, extensionKey: 'MIIB' }).key).toBeUndefined();
  });

  it('pins other builds to the development id, or to a configured key', () => {
    expect(manifestFor({ store: false }).key).toBe(DEVELOPMENT_KEY);
    expect(manifestFor({ store: false, extensionKey: ' MIIB ' }).key).toBe('MIIB');
  });

  it('has a development key whose id is the one WeldID lists', () => {
    expect(extensionId(DEVELOPMENT_KEY)).toBe(DEVELOPMENT_ID);
  });

  it('suggests a shortcut for opening the popup', () => {
    expect(manifest.commands._execute_action.suggested_key.default).toMatch(/^(Ctrl|Alt)\+/);
  });

  it('builds without icons', () => {
    expect(manifestFor({ hasIcons: false }).icons).toBeUndefined();
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

  it("keeps the store description within Chrome's 132 characters", () => {
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
