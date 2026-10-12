import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { getAppLucideIcon, isHiddenFromOnboarding } from '@/lib/apps/app-registry';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';

describe('WeldReach module registration', () => {
  const config = MODULE_CONFIGS.weldreach!;

  it('is recognised as a module from its URL', () => {
    expect(getModuleKey('/weldreach')).toBe('weldreach');
    expect(getModuleKey('/weldreach/campaigns/rcp_1')).toBe('weldreach');
  });

  it('lists the six sections, each gated on the object it reads', () => {
    const items = config.getMenuItems(en).flatMap((group) => group.items);
    expect(items.map((item) => [item.href, item.permission])).toEqual([
      ['/weldreach', undefined],
      ['/weldreach/campaigns', 'reach_campaigns:read'],
      ['/weldreach/prospects', 'reach_prospects:read'],
      ['/weldreach/inbox', 'reach_inbox:read'],
      ['/weldreach/mailboxes', 'reach_mailboxes:read'],
      ['/weldreach/settings', 'reach_settings:read'],
    ]);
  });

  it('translates the section names', () => {
    const titles = (language: typeof en) => config.getMenuItems(language).flatMap((group) => group.items.map((item) => item.title));
    expect(titles(en)).toEqual(['Overview', 'Campaigns', 'Prospects', 'Inbox', 'Mailboxes & domains', 'Settings']);
    expect(titles(nl as unknown as typeof en)).toEqual([
      'Overzicht',
      'Campagnes',
      'Prospects',
      'Inbox',
      'Mailboxen & domeinen',
      'Instellingen',
    ]);
  });

  it('has an icon and stays out of onboarding, since it cannot be installed without approval', () => {
    expect(getAppLucideIcon('weldreach')).toBeDefined();
    expect(isHiddenFromOnboarding('weldreach')).toBe(true);
  });
});
