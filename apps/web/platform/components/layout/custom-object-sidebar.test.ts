import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { TranslationsType } from '@/lib/i18n/types';
import { buildCustomObjectSidebarConfig } from './custom-object-sidebar';

const machines = { id: 'cobj_1', slug: 'machines', labelPlural: 'Machines', icon: 'Cog' };

describe('buildCustomObjectSidebarConfig', () => {
  it('brands the sidebar with the object and links its records and settings', () => {
    const config = buildCustomObjectSidebarConfig(machines);
    const groups = config.getMenuItems(en);

    expect(config.appName).toBe('Machines');
    expect(groups.map((g) => g.group)).toEqual(['General', 'Settings']);
    expect(groups[0].items).toEqual([expect.objectContaining({ title: 'Machines', href: '/objects/machines' })]);
    expect(groups[1].items).toEqual([
      expect.objectContaining({
        title: 'Object settings',
        href: '/settings/custom-objects/cobj_1',
        permission: 'weldobjects:manage',
      }),
    ]);
  });

  it('translates the settings item', () => {
    const groups = buildCustomObjectSidebarConfig(machines).getMenuItems(nl as unknown as TranslationsType);
    expect(groups[1].items[0].title).toBe('Objectinstellingen');
  });
});
