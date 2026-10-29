import { afterEach, describe, expect, it } from 'vitest';
import { isAppOffered, isModuleOffered, moduleForApp, offeredModules } from './edition';
import { setRuntimeConfig } from './runtime-config';

afterEach(() => setRuntimeConfig(null));

describe('edition flags', () => {
  it('offers everything on Global (no runtime config)', () => {
    expect(offeredModules()).toBeNull();
    expect(isModuleOffered('crm')).toBe(true);
    expect(isAppOffered('welddesk')).toBe(true);
  });

  it('offers everything when the config has no module list', () => {
    setRuntimeConfig({ backend: 'workers' });
    expect(offeredModules()).toBeNull();
    expect(isAppOffered('weldmail')).toBe(true);
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
    expect(isAppOffered('my-custom-object')).toBe(true);
  });

  it("maps an app to the module whose own app it is, not to modules that merely serve it", () => {
    // weldcommerce is listed by crm too, but it is commerce's own app.
    expect(moduleForApp('weldcommerce')).toBe('commerce');
    expect(moduleForApp('weldcrm')).toBe('crm');
    expect(moduleForApp('parcel')).toBe('commerce');
    expect(moduleForApp('weldcalendar')).toBe('calendar');
  });
});
