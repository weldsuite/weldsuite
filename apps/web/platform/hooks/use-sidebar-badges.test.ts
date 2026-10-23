import { describe, it, expect } from 'vitest';
import { railBadgeCountFor, type SidebarBadgeCounts } from './use-sidebar-badges';

const counts: SidebarBadgeCounts = { mail: 12, helpdesk: 4, orders: 9 };

describe('railBadgeCountFor', () => {
  it('maps the badge counts to their apps', () => {
    expect(railBadgeCountFor('weldmail', counts, 3)).toBe(12);
    expect(railBadgeCountFor('welddesk', counts, 3)).toBe(4);
    expect(railBadgeCountFor('weldchat', counts, 3)).toBe(3);
  });

  it('gives pending orders to no app', () => {
    expect(railBadgeCountFor('weldcommerce', counts, 3)).toBeUndefined();
    expect(railBadgeCountFor('weldconnect', counts, 3)).toBeUndefined();
  });

  it('has no badge for other apps', () => {
    expect(railBadgeCountFor('weldcrm', counts, 3)).toBeUndefined();
    expect(railBadgeCountFor('my-weldapp', counts, 3)).toBeUndefined();
  });
});
