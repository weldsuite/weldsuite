import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { getAppLucideIcon, isHiddenFromOnboarding } from '@/lib/apps/app-registry';
import { getAppPermissionObjects } from '@/lib/apps/app-permission-objects';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';

describe('WeldSign module registration', () => {
  const config = MODULE_CONFIGS.weldsign!;

  it('is recognised as a module from its URL', () => {
    expect(getModuleKey('/weldsign')).toBe('weldsign');
    expect(getModuleKey('/weldsign/sgn_1')).toBe('weldsign');
  });

  it('lists the signature requests, gated on sign_envelopes:read', () => {
    const items = config.getMenuItems(en).flatMap((group) => group.items);
    expect(items.map((item) => [item.href, item.permission])).toEqual([['/weldsign', 'sign_envelopes:read']]);
  });

  it('translates the section names', () => {
    const titles = (language: typeof en) => config.getMenuItems(language).flatMap((group) => group.items.map((item) => item.title));
    expect(titles(en)).toEqual(['Signature requests']);
    expect(titles(nl as unknown as typeof en)).toEqual(['Ondertekenverzoeken']);
  });

  it('has an icon and its permission objects', () => {
    expect(getAppLucideIcon('weldsign')).toBeDefined();
    expect(isHiddenFromOnboarding('weldsign')).toBe(false);
    expect(getAppPermissionObjects('weldsign')).toEqual(['sign_envelopes', 'sign_templates']);
  });
});
