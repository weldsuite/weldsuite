import { describe, it, expect } from 'vitest';
import { appFromPathname } from './current-app';

describe('appFromPathname', () => {
  it.each([
    ['/weldcrm/companies', 'weldcrm'],
    ['/welddesk', 'welddesk'],
    ['/social/posts', 'weldsocial'],
    ['/apps/weldstash/products', 'weldstash'],
    ['/apps/some-user-app', null],
    ['/settings/roles', null],
    ['/objects/machines', null],
    ['/', null],
  ])('%s → %s', (path, app) => {
    expect(appFromPathname(path)).toBe(app);
  });
});
