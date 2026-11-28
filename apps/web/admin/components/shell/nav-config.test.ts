import { describe, expect, it } from 'vitest';
import { getActiveArea, getNavAreas, isItemActive } from './nav-config';

/** Every href the navigation offers: area links and the items in their groups. */
function hrefs(): string[] {
  return getNavAreas().flatMap((area) => [area.href, ...area.groups.flatMap((group) => group.items.map((item) => item.href))]);
}

describe('getNavAreas', () => {
  it('offers every page of the console', () => {
    expect(hrefs()).toEqual(
      expect.arrayContaining([
        '/',
        '/apps',
        '/apps/new',
        '/access-requests',
        '/warmup',
        '/outbound-mail',
        '/weldforms',
        '/workspaces',
        '/plans',
        '/plans/new',
        '/activity',
        '/staff',
        '/flags',
      ]),
    );
  });

  it('leaves no area empty', () => {
    for (const area of getNavAreas()) {
      expect(area.groups.flatMap((group) => group.items).length).toBeGreaterThan(0);
    }
  });
});

describe('getActiveArea', () => {
  it('finds the area of a nested page, and of a path it also matches', () => {
    expect(getActiveArea('/apps/new').key).toBe('apps');
    expect(getActiveArea('/activity').key).toBe('billing');
  });

  it('falls back to Overview', () => {
    expect(getActiveArea('/nowhere').key).toBe('overview');
  });
});

describe('isItemActive', () => {
  it('matches exactly or a deeper page, never the root on another page', () => {
    expect(isItemActive('/apps', '/apps')).toBe(true);
    expect(isItemActive('/apps/app_1', '/apps')).toBe(true);
    expect(isItemActive('/apps', '/')).toBe(false);
  });
});
