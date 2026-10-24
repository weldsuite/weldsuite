import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { getAppLucideIcon, isHiddenFromOnboarding } from '@/lib/apps/app-registry';
import { getAppPermissionObjects } from '@/lib/apps/app-permission-objects';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';
import { menuPermissionAllows } from './menu-permission';

describe('WeldSign module registration', () => {
  const config = MODULE_CONFIGS.weldsign!;

  it('is recognised as a module from its URL', () => {
    expect(getModuleKey('/weldsign')).toBe('weldsign');
    expect(getModuleKey('/weldsign/sgn_1')).toBe('weldsign');
    expect(getModuleKey('/weldsign/templates')).toBe('weldsign');
    expect(getModuleKey('/weldsign/templates/sgn_1')).toBe('weldsign');
  });

  it('lists the signature requests and the templates, each gated on its own read permission', () => {
    const items = config.getMenuItems(en).flatMap((group) => group.items);
    expect(items.map((item) => [item.href, item.permission])).toEqual([
      ['/weldsign', 'sign_envelopes:read'],
      ['/weldsign/templates', 'sign_templates:read'],
    ]);
  });

  it('shows Templates only to a member who may read templates', () => {
    const templates = config.getMenuItems(en).flatMap((group) => group.items).find((item) => item.href === '/weldsign/templates')!;
    expect(menuPermissionAllows(templates.permission, (permission) => permission === 'sign_templates:read')).toBe(true);
    expect(menuPermissionAllows(templates.permission, (permission) => permission === 'sign_envelopes:read')).toBe(false);
  });

  it('translates the section names', () => {
    const titles = (language: typeof en) => config.getMenuItems(language).flatMap((group) => group.items.map((item) => item.title));
    expect(titles(en)).toEqual(['Signature requests', 'Templates']);
    expect(titles(nl as unknown as typeof en)).toEqual(['Ondertekenverzoeken', 'Sjablonen']);
  });

  it('has an icon and its permission objects', () => {
    expect(getAppLucideIcon('weldsign')).toBeDefined();
    expect(isHiddenFromOnboarding('weldsign')).toBe(false);
    expect(getAppPermissionObjects('weldsign')).toEqual(['sign_envelopes', 'sign_templates']);
  });
});
