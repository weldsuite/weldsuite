import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { getAppLucideIcon, isHiddenFromOnboarding } from '@/lib/apps/app-registry';
import { getAppPermissionObjects } from '@/lib/apps/app-permission-objects';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';

describe('WeldMerge module registration', () => {
  const config = MODULE_CONFIGS.weldmerge!;

  it('is recognised as a module from its URL', () => {
    expect(getModuleKey('/weldmerge')).toBe('weldmerge');
    expect(getModuleKey('/weldmerge/pull-requests')).toBe('weldmerge');
    expect(getModuleKey('/weldmerge/issues/PLAT-209')).toBe('weldmerge');
  });

  it('lists inbox, pull requests, issues, cycles and releases, each gated on its permission, with settings left to workspace Settings', () => {
    const items = config.getMenuItems(en).flatMap((group) => group.items);
    expect(items.map((item) => [item.href, item.permission])).toEqual([
      ['/weldmerge', 'merge_pull_requests:read'],
      ['/weldmerge/pull-requests', 'merge_pull_requests:read'],
      ['/weldmerge/issues', 'merge_issues:read'],
      ['/weldmerge/cycles', 'merge_issues:read'],
      ['/weldmerge/releases', 'merge_releases:read'],
    ]);
  });

  it('translates the section names', () => {
    const titles = (language: typeof en) => config.getMenuItems(language).flatMap((group) => group.items.map((item) => item.title));
    expect(titles(en)).toEqual(['Inbox', 'Pull requests', 'Issues', 'Cycles', 'Releases']);
    expect(titles(nl as unknown as typeof en)).toEqual(['Inbox', 'Pull requests', 'Issues', 'Cycli', 'Releases']);
  });

  it('has an icon and its permission objects', () => {
    expect(getAppLucideIcon('weldmerge')).toBeDefined();
    expect(isHiddenFromOnboarding('weldmerge')).toBe(false);
    expect(getAppPermissionObjects('weldmerge')).toEqual(['merge_issues', 'merge_pull_requests', 'merge_releases', 'merge_teams', 'merge_connections']);
  });
});
