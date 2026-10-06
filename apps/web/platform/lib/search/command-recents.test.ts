import { beforeEach, describe, expect, it } from 'vitest';
import { getRecentCommands, pushRecentCommand } from './command-recents';

describe('command recents', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps the latest command first and drops duplicates', () => {
    pushRecentCommand('org_1', { id: 'nav:home', title: 'Home', subtitle: 'WeldSuite', href: '/' });
    pushRecentCommand('org_1', { id: 'settings', title: 'Settings', subtitle: '', href: '/settings' });
    pushRecentCommand('org_1', { id: 'nav:home', title: 'Home', subtitle: 'WeldSuite', href: '/' });

    expect(getRecentCommands('org_1').map((item) => item.id)).toEqual(['nav:home', 'settings']);
    expect(getRecentCommands('org_2')).toEqual([]);
  });
});