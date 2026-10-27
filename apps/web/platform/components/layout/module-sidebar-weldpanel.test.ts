import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { getAppLucideIcon, isHiddenFromOnboarding } from '@/lib/apps/app-registry';
import { getAppPermissionObjects } from '@/lib/apps/app-permission-objects';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';

describe('WeldPanel module registration', () => {
  const config = MODULE_CONFIGS.weldpanel!;

  it('is recognised as a module from its URL', () => {
    expect(getModuleKey('/weldpanel')).toBe('weldpanel');
    expect(getModuleKey('/weldpanel/recordings')).toBe('weldpanel');
  });

  it('lists the overview, gated on panel_projects:read', () => {
    const items = config.getMenuItems(en).flatMap((group) => group.items);
    expect(items.map((item) => [item.href, item.permission])).toEqual([['/weldpanel', 'panel_projects:read']]);
  });

  it('translates the section names', () => {
    const titles = (language: typeof en) => config.getMenuItems(language).flatMap((group) => group.items.map((item) => item.title));
    expect(titles(en)).toEqual(['Overview']);
    expect(titles(nl as unknown as typeof en)).toEqual(['Overzicht']);
  });

  it('has an icon and its permission objects', () => {
    expect(getAppLucideIcon('weldpanel')).toBeDefined();
    expect(isHiddenFromOnboarding('weldpanel')).toBe(false);
    expect(getAppPermissionObjects('weldpanel')).toEqual(['panel_projects', 'panel_reports', 'panel_recordings', 'panel_people']);
  });
});
