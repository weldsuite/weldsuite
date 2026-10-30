import { afterEach, describe, expect, it } from 'vitest';
import { API_MODULES } from '@weldsuite/api-modules';
import { APP_CODE_ALIASES, PERMISSION_APPS } from '@weldsuite/permissions';
import {
  EDITION_FEATURES,
  isAppOffered,
  isFeatureAvailable,
  isModuleOffered,
  moduleForApp,
  offeredModules,
} from './edition';
import { setRuntimeConfig } from './runtime-config';

/** What the EU cluster's `/config.json` answers today. */
const EU_CONFIG = {
  backend: 'rust',
  edition: 'eu',
  modules: ['core', 'know', 'sign', 'pass', 'calendar'],
  unavailableFeatures: ['sso-connections', 'billing', 'credit-top-up', 'paid-apps', 'desktop-sign-in', 'analytics', 'search-reindex', 'company-logos', 'mail-domains', 'mail-free-addresses', 'mail-ai', 'chat-calls', 'helpcenter-custom-domains'],
};

afterEach(() => setRuntimeConfig(null));

describe('edition flags', () => {
  it('offers everything on Global (no runtime config)', () => {
    expect(offeredModules()).toBeNull();
    expect(isModuleOffered('crm')).toBe(true);
    expect(isAppOffered('welddesk')).toBe(true);
    for (const feature of EDITION_FEATURES) expect(isFeatureAvailable(feature)).toBe(true);
  });

  it('offers everything when the config has no module list', () => {
    setRuntimeConfig({ backend: 'workers' });
    expect(offeredModules()).toBeNull();
    expect(isAppOffered('weldmail')).toBe(true);
    expect(isModuleOffered('agent')).toBe(true);
    expect(isFeatureAvailable('billing')).toBe(true);
  });

  it('hides the apps of modules the backend does not serve', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'know', 'sign'] });
    expect(isAppOffered('weldknow')).toBe(true);
    expect(isAppOffered('weldsign')).toBe(true);
    expect(isAppOffered('weldcrm')).toBe(false);
    expect(isAppOffered('welddesk')).toBe(false);
    expect(isModuleOffered('agent')).toBe(false);
  });

  it('always offers the core platform, its apps and workspace-made apps', () => {
    setRuntimeConfig({ backend: 'rust', modules: [] });
    expect(isModuleOffered('core')).toBe(true);
    expect(isAppOffered('welddrive')).toBe(true);
    expect(isAppOffered('weldsuite')).toBe(true);
    expect(isAppOffered('my-custom-object')).toBe(true);
  });

  it('offers the EU modules and nothing else', () => {
    setRuntimeConfig(EU_CONFIG);
    for (const app of ['weldknow', 'weldsign', 'weldpass', 'weldcalendar', 'welddrive']) {
      expect(isAppOffered(app)).toBe(true);
    }
    for (const app of ['weldcrm', 'weldmail', 'weldflow', 'weldchat', 'weldagent', 'weldmeet', 'parcel', 'social']) {
      expect(isAppOffered(app)).toBe(false);
    }
  });

  it("maps an app to the module whose own app it is, not to modules that merely serve it", () => {
    // weldcommerce is listed by crm too, but it is commerce's own app.
    expect(moduleForApp('weldcommerce')).toBe('commerce');
    expect(moduleForApp('weldcrm')).toBe('crm');
    expect(moduleForApp('parcel')).toBe('commerce');
    expect(moduleForApp('weldcalendar')).toBe('calendar');
  });

  it('resolves WeldAgent to the agent module', () => {
    expect(moduleForApp('weldagent')).toBe('agent');
    expect(moduleForApp('agent')).toBe('agent');
  });

  it('resolves legacy app codes through the permission shim', () => {
    expect(moduleForApp('task')).toBe('connect');
    expect(moduleForApp('accounting')).toBe('books');
    expect(moduleForApp('wms')).toBe('stash');
    expect(moduleForApp('host')).toBe('host');
    expect(moduleForApp('helpdesk')).toBe('desk');
    expect(moduleForApp('projects')).toBe('flow');
    expect(moduleForApp('social')).toBe('social');
    expect(moduleForApp('knowledge')).toBe('know');
    expect(moduleForApp('WeldCRM')).toBe('crm');
    setRuntimeConfig(EU_CONFIG);
    expect(isAppOffered('accounting')).toBe(false);
    expect(isAppOffered('knowledge')).toBe(true);
  });

  it('maps no first-party app code to core by accident', () => {
    const core = new Set(['welddrive', 'drive', 'weldsuite']);
    const codes = new Set([
      ...PERMISSION_APPS.map((app) => app.code),
      ...Object.keys(APP_CODE_ALIASES),
      ...API_MODULES.flatMap((module) => module.apps ?? []),
      'weldagent',
      'parcel',
    ]);
    for (const code of codes) {
      if (core.has(code)) expect(moduleForApp(code), code).toBe('core');
      else expect(moduleForApp(code), code).not.toBe('core');
    }
    for (const module of API_MODULES) {
      const own = module.apps?.[0];
      if (own) expect(moduleForApp(own), own).toBe(module.id);
    }
  });

  it('hides the features the backend lists as unavailable', () => {
    setRuntimeConfig(EU_CONFIG);
    for (const feature of EDITION_FEATURES) expect(isFeatureAvailable(feature)).toBe(false);
    setRuntimeConfig({ backend: 'rust', modules: ['core'], unavailableFeatures: ['billing', 'a-future-feature'] });
    expect(isFeatureAvailable('billing')).toBe(false);
    expect(isFeatureAvailable('credit-top-up')).toBe(true);
  });
});
