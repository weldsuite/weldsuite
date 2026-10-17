import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';

describe('WeldBooks sidebar', () => {
  it('has no settings page: the settings live on the entity in Settings → Entities', () => {
    const items = MODULE_CONFIGS.weldbooks!.getMenuItems(en).flatMap((group) => group.items);
    const hrefs = items.map((item) => item.href);
    expect(hrefs).not.toContain('/weldbooks/settings');
    // Dimensions keep their own page in WeldBooks.
    expect(hrefs).toContain('/weldbooks/settings/dimensions');
  });
});

describe('getModuleKey', () => {
  it('maps module paths to their module', () => {
    expect(getModuleKey('/weldcrm/companies')).toBe('weldcrm');
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
