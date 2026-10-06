import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { Home } from 'lucide-react';
import {
  actionCommands,
  navigationCommandsForApps,
  pagesForModule,
  settingsCommands,
  visibleCommands,
  type PaletteCommand,
  type SidebarPage,
} from './palette-commands';

const icon = Home;

function page(partial: Partial<SidebarPage> & Pick<SidebarPage, 'title' | 'href'>): SidebarPage {
  return { icon, ...partial };
}

function titles(commands: PaletteCommand[]) {
  return commands.map((command) => command.title);
}

describe('navigationCommandsForApps', () => {
  const apps = [
    { appCode: 'weldcrm', name: 'WeldCRM', appType: 'system' as const },
    { appCode: 'acme-board', name: 'Acme Board', appType: 'user' as const },
  ];

  const pages: Record<string, SidebarPage[]> = {
    weldcrm: [
      page({ title: 'My Tasks', href: '/weldcrm' }),
      page({ title: 'Companies', href: '/weldcrm/companies', permission: 'customers:read' }),
      page({ title: 'People', href: '/weldcrm/people', permission: 'contacts:read' }),
    ],
  };

  it('lists installed apps before a query and hides pages the user cannot open', () => {
    const commands = navigationCommandsForApps(
      apps,
      (code) => pages[code] ?? [],
      () => icon,
      (permission) => permission !== 'contacts:read',
    );
    const empty = visibleCommands(commands, '');
    expect(titles(empty)).toEqual(['WeldCRM', 'Acme Board']);
    expect(empty.find((command) => command.title === 'Acme Board')?.href).toBe('/apps/acme-board');

    const companies = visibleCommands(commands, 'companies');
    expect(titles(companies)).toEqual(['Companies']);

    expect(visibleCommands(commands, 'people')).toEqual([]);
  });

  it('reads WeldCRM pages from the module sidebar config', () => {
    const pagesForCrm = pagesForModule('weldcrm', en);
    expect(pagesForCrm.map((page) => page.href)).toContain('/weldcrm/companies');
  });
});

describe('visibleCommands', () => {
  it('shows the settings root when idle and filters the rest by query', () => {
    const commands = settingsCommands(en, new Set(['weldcrm']));
    expect(titles(visibleCommands(commands, ''))).toEqual(['Settings']);
    expect(titles(visibleCommands(commands, 'billing'))).toContain('Billing');
    expect(titles(visibleCommands(commands, 'crm'))).toContain('WeldCRM');
    expect(titles(visibleCommands(commands, 'parcel'))).not.toContain('Parcel Settings');
  });

  it('requires every word in the query to match', () => {
    const commands = settingsCommands(en, new Set());
    expect(visibleCommands(commands, 'team members').some((command) => command.href === '/settings/team')).toBe(true);
    expect(visibleCommands(commands, 'team zebra')).toEqual([]);
  });
});

describe('actionCommands create records', () => {
  const crm = { canSee: (permission: string | undefined) => permission === 'companies:create' || permission === 'people:create', installedCodes: new Set(['weldcrm']) };

  it('includes create actions when an installed app exposes the record and the member can create it', () => {
    const titles = actionCommands(en, 'light', crm).map((command) => command.title);
    expect(titles).toContain('Create company');
    expect(titles).toContain('Create person');
  });

  it('omits a create action without permission or without a matching installed app', () => {
    const peopleOnly = actionCommands(en, 'light', {
      canSee: (permission) => permission === 'people:create',
      installedCodes: new Set(['weldcrm']),
    }).map((command) => command.id);
    expect(peopleOnly).not.toContain('action:create-company');
    expect(peopleOnly).toContain('action:create-person');

    const stash = actionCommands(en, 'light', {
      canSee: () => true,
      installedCodes: new Set(['weldstash']),
    }).map((command) => command.id);
    expect(stash).not.toContain('action:create-company');
    expect(stash).not.toContain('action:create-person');
  });
});
