import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';

describe('module sidebars', () => {
  // AGENTS.md, "App settings live in Settings": an app's settings are reached
  // only from Settings → Apps (`/settings/apps/{appCode}`), never from the
  // app's own menu.
  it.each(Object.keys(MODULE_CONFIGS).filter((key) => key !== 'settings'))('%s has no settings item', (key) => {
    const groups = MODULE_CONFIGS[key]!.getMenuItems(en);
    expect(groups.map((group) => group.group)).not.toContain(en.navigation.moduleSidebar.groups.settings);
    for (const item of groups.flatMap((group) => group.items)) {
      expect(item.href).not.toMatch(/^\/settings(\/|$)/);
      expect(item.href).not.toMatch(/\/settings(\/|$|\?)/);
    }
  });

  it('keeps WeldBooks fiscal periods, month-end work, in the app', () => {
    const hrefs = MODULE_CONFIGS.weldbooks!.getMenuItems(en).flatMap((group) => group.items.map((item) => item.href));
    expect(hrefs).toContain('/weldbooks/fiscal-periods');
  });
});

describe('getModuleKey', () => {
  it('maps module paths to their module', () => {
    expect(getModuleKey('/weldcrm/companies')).toBe('weldcrm');
    expect(getModuleKey('/weldsheets/sh_123')).toBe('weldsheets');
    expect(getModuleKey('/welddocs/doc_123')).toBe('welddocs');
    expect(getModuleKey('/')).toBe('home');
  });

  it('gives settings the unified sidebar', () => {
    expect(getModuleKey('/settings')).toBe('settings');
    expect(getModuleKey('/settings/apps/weldhr')).toBe('settings');
  });

  it('keys custom objects by slug, on the list and on a record', () => {
    expect(getModuleKey('/objects/machines')).toBe('object:machines');
    expect(getModuleKey('/objects/machines/rec_123')).toBe('object:machines');
  });

  it('keys hosted WeldApps by code', () => {
    expect(getModuleKey('/apps/time-tracker/reports')).toBe('user-app:time-tracker');
  });

  it('leaves pages without a module sidebar unmapped', () => {
    expect(getModuleKey('/appstore')).toBeNull();
    expect(getModuleKey('/documents/file_1')).toBeNull();
    expect(getModuleKey('/objects')).toBeNull();
  });
});
