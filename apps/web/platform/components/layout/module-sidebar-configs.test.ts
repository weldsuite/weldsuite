import { describe, expect, it } from 'vitest';
import { getModuleKey } from './module-sidebar-configs';

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
