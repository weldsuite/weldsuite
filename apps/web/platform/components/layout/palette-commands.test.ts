import { afterEach, describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { Home } from 'lucide-react';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { isWeldbooksHrefVisible } from '@/lib/weldbooks/jurisdiction-menu';
import { NO_JURISDICTION_FEATURES, type JurisdictionFeatures } from '@/lib/weldbooks/jurisdiction';
import {
  CREATE_ACTIONS,
  actionCommands,
  agentNavigationCommands,
  createCommands,
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

describe('WeldBooks pages follow the entity country', () => {
  const nl: JurisdictionFeatures = { ...NO_JURISDICTION_FEATURES, vatReturn: true, icp: true };
  const us: JurisdictionFeatures = { ...NO_JURISDICTION_FEATURES, salesTax: true, form1099: true };
  const br: JurisdictionFeatures = { ...NO_JURISDICTION_FEATURES, brTaxReturn: true, fiscalDocuments: true };
  const hrefsFor = (known: boolean, features: JurisdictionFeatures) =>
    pagesForModule('weldbooks', en, { isHrefVisible: (href) => isWeldbooksHrefVisible(href, { known, features }) }).map(
      (p) => p.href,
    );

  it('gives a Dutch entity no US or Brazil only pages', () => {
    const hrefs = hrefsFor(true, nl);
    expect(hrefs).toContain('/weldbooks/invoices');
    expect(hrefs).toContain('/weldbooks/vat');
    for (const gone of [
      '/weldbooks/sales-tax',
      '/weldbooks/tax-calendar',
      '/weldbooks/payment-runs',
      '/weldbooks/deposits',
      '/weldbooks/banking/statements',
      '/weldbooks/reports/tax-worksheet',
      '/weldbooks/form-1099',
      '/weldbooks/received-nfe',
    ]) {
      expect(hrefs).not.toContain(gone);
    }
    expect(hrefs.some((href) => href.startsWith('/weldbooks/sales-tax/'))).toBe(false);
  });

  it('gives a US entity the US pages and no VAT or NF-e', () => {
    const hrefs = hrefsFor(true, us);
    expect(hrefs).toContain('/weldbooks/sales-tax');
    expect(hrefs).toContain('/weldbooks/form-1099');
    expect(hrefs).not.toContain('/weldbooks/vat');
    expect(hrefs).not.toContain('/weldbooks/received-nfe');
  });

  it('gives a Brazilian entity the NF-e inbox', () => {
    expect(hrefsFor(true, br)).toContain('/weldbooks/received-nfe');
  });

  it('hides every gated page until the jurisdiction is known', () => {
    const hrefs = hrefsFor(false, us);
    expect(hrefs).not.toContain('/weldbooks/sales-tax');
    expect(hrefs).toContain('/weldbooks/invoices');
  });

  it('leaves other modules alone without a visibility rule', () => {
    expect(pagesForModule('weldcrm', en).map((p) => p.href)).toContain('/weldcrm/companies');
  });
});

describe('visibleCommands', () => {
  it('shows the settings root when idle and filters the rest by query', () => {
    const commands = settingsCommands(en, new Set(['weldcrm']));
    expect(titles(visibleCommands(commands, ''))).toEqual(['Settings']);
    expect(titles(visibleCommands(commands, 'billing'))).toContain('Billing');
    expect(titles(visibleCommands(commands, 'crm'))).toContain('WeldCRM');
    expect(titles(visibleCommands(commands, 'parcel'))).not.toContain('Parcel Settings');
    expect(visibleCommands(commands, 'weldhr').some((command) => command.href === '/settings/apps/weldhr')).toBe(false);
    const withHr = settingsCommands(en, new Set(['weldhr']));
    expect(visibleCommands(withHr, 'weldhr').some((command) => command.href === '/settings/apps/weldhr')).toBe(true);
  });

  it('requires every word in the query to match', () => {
    const commands = settingsCommands(en, new Set());
    expect(visibleCommands(commands, 'team members').some((command) => command.href === '/settings/team')).toBe(true);
    expect(visibleCommands(commands, 'team zebra')).toEqual([]);
  });
});

describe('edition flags', () => {
  afterEach(() => setRuntimeConfig(null));

  it('lists only the settings pages the EU edition serves', () => {
    setRuntimeConfig({
      backend: 'rust',
      modules: ['core', 'know', 'sign', 'pass', 'calendar'],
      unavailableFeatures: ['sso-connections', 'billing', 'credit-top-up'],
    });
    const hrefs = settingsCommands(en, new Set(['weldcrm'])).map((command) => command.href);
    expect(hrefs).toContain('/settings/team');
    // API keys only work once the deployment names its public API (TASK-1418).
    for (const hidden of ['/settings/api-keys', '/settings/sso', '/settings/plans', '/settings/billing', '/settings/webhooks', '/settings/integrations', '/settings/apps/phone-numbers', '/settings/apps/weldcrm']) {
      expect(hrefs, hidden).not.toContain(hidden);
    }
  });

  it('lists API keys once the deployment names its public API', () => {
    setRuntimeConfig({
      backend: 'rust',
      modules: ['core'],
      unavailableFeatures: ['sso-connections', 'billing', 'credit-top-up'],
      env: { VITE_EXTERNAL_API_URL: 'https://api.example.eu' },
    });
    const hrefs = settingsCommands(en, new Set()).map((command) => command.href);
    expect(hrefs).toContain('/settings/api-keys');
  });

  it('keeps the billing page for the credit top-up when Stripe billing is unavailable', () => {
    setRuntimeConfig({
      backend: 'rust',
      modules: ['core'],
      unavailableFeatures: ['sso-connections', 'billing'],
    });
    const hrefs = settingsCommands(en, new Set()).map((command) => command.href);
    expect(hrefs).toContain('/settings/billing');
    expect(hrefs).not.toContain('/settings/plans');
  });

  it('keeps every settings page on Global', () => {
    const hrefs = settingsCommands(en, new Set()).map((command) => command.href);
    expect(hrefs).toEqual(expect.arrayContaining(['/settings/sso', '/settings/billing', '/settings/integrations']));
  });

  it('offers no company or person creation without the crm module', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'commerce'] });
    const access = { canSee: () => true, installedCodes: new Set(['weldcommerce']) };
    const ids = actionCommands(en, 'light', access).map((command) => command.id);
    expect(ids).not.toContain('action:create-company');
    expect(ids).not.toContain('action:create-person');
  });

  it("drops a module's pages that link into one the deployment doesn't serve", () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'calendar'] });
    const commands = navigationCommandsForApps(
      [{ appCode: 'weldcalendar', name: 'WeldCalendar', appType: 'system' }],
      () => [page({ title: 'Week', href: '/weldcalendar/week' }), page({ title: 'Tasks', href: '/weldflow/my-tasks' })],
      () => icon,
      () => true,
    );
    expect(commands.map((command) => command.href)).toEqual(['/weldcalendar', '/weldcalendar/week']);
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

describe('createCommands', () => {
  const installed = new Set(['welddocs', 'weldforms', 'weldcrm']);
  const names: Record<string, string> = { welddocs: 'WeldDocs', weldforms: 'WeldForms', weldcrm: 'WeldCRM', agents: 'AI Agents' };
  const allowAll = { canSee: () => true, installedCodes: installed, appName: (code: string) => names[code] };

  afterEach(() => setRuntimeConfig(null));

  it('offers a Create action for each installed app, linking to the page that starts it', () => {
    const commands = createCommands(en, allowAll);
    const ids = commands.map((command) => command.id);
    expect(ids).toEqual(expect.arrayContaining(['create:document', 'create:form', 'create:crm-task', 'create:crm-note']));
    expect(ids).not.toContain('create:sheet');
    const doc = commands.find((command) => command.id === 'create:document');
    expect(doc).toMatchObject({ title: 'Create document', subtitle: 'WeldDocs', href: '/welddocs?new=1', group: 'actions' });
  });

  it('checks the create permission in the app that owns the record', () => {
    const asked: Array<[string | undefined, string | null | undefined]> = [];
    const ids = createCommands(en, {
      installedCodes: installed,
      canSee: (permission, app) => {
        asked.push([permission, app]);
        return app === 'welddocs' && permission === 'docs:create';
      },
    }).map((command) => command.id);
    expect(ids).toEqual(['create:document']);
    expect(asked).toContainEqual(['forms:create', 'weldforms']);
  });

  it("shows only the current app's actions before typing, and all of them when typing", () => {
    const commands = createCommands(en, { ...allowAll, currentApp: 'welddocs' });
    expect(visibleCommands(commands, '').map((command) => command.id)).toEqual(['create:document']);
    expect(visibleCommands(commands, 'create').map((command) => command.id)).toEqual(
      expect.arrayContaining(['create:document', 'create:form', 'create:crm-task']),
    );
    expect(visibleCommands(commands, 'nieuw formulier').map((command) => command.id)).toEqual(['create:form']);
  });

  it('shows Create company before typing on home and in WeldCRM, not in another app', () => {
    const shown = (currentApp: string | null) =>
      visibleCommands(actionCommands(en, 'light', { ...allowAll, currentApp }), '').map((command) => command.id);
    expect(shown(null)).toContain('action:create-company');
    expect(shown('weldcrm')).toContain('action:create-company');
    expect(shown('welddocs')).not.toContain('action:create-company');
  });

  it('drops Create actions whose app this edition does not serve', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'docs'] });
    const ids = createCommands(en, allowAll).map((command) => command.id);
    expect(ids).toContain('create:document');
    expect(ids).not.toContain('create:form');
  });

  it('offers a WeldAgent agent without an install, when the edition has the module', () => {
    expect(createCommands(en, allowAll).map((command) => command.id)).toContain('create:agent');
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'docs'] });
    expect(createCommands(en, allowAll).map((command) => command.id)).not.toContain('create:agent');
  });

  it('gives every Create action a title in English and Dutch', () => {
    for (const action of CREATE_ACTIONS) {
      expect(action.title(en.sweep.shared.commandPalette.create), action.id).toBeTruthy();
      expect(action.title(nl.sweep.shared.commandPalette.create), action.id).toBeTruthy();
    }
  });
});

describe('pages of modules whose sidebar is built by a hook', () => {
  it('lists their fixed pages', () => {
    const hrefs = (code: string) => pagesForModule(code, en).map((p) => p.href);
    expect(hrefs('weldflow')).toEqual(expect.arrayContaining(['/weldflow', '/weldflow/projects', '/weldflow/workload']));
    expect(hrefs('weldmail')).toEqual(expect.arrayContaining(['/weldmail/unified/inbox', '/weldmail/unified/sent']));
    expect(hrefs('weldchat')).toEqual(expect.arrayContaining(['/weldchat/activity', '/weldchat/bookmarks']));
    expect(hrefs('weldconnect')).toEqual(expect.arrayContaining(['/weldconnect/workflows', '/weldconnect/executions']));
    expect(hrefs('weldcalendar')).toContain('/weldcalendar/scheduling');
  });

  it("checks a page's permission in its own app", () => {
    const commands = navigationCommandsForApps(
      [{ appCode: 'weldflow', name: 'WeldFlow', appType: 'system' }],
      (code) => pagesForModule(code, en),
      () => icon,
      (permission, app) => !(permission === 'portfolio:read' && app === 'weldflow'),
    );
    const hrefs = commands.map((command) => command.href);
    expect(hrefs).toContain('/weldflow/workload');
    expect(hrefs).not.toContain('/weldflow/intake');
  });

  it('lists WeldAgent next to the installed apps', () => {
    expect(visibleCommands(agentNavigationCommands(en), '').map((command) => command.href)).toEqual(['/agents']);
    setRuntimeConfig({ backend: 'rust', modules: ['core'] });
    expect(agentNavigationCommands(en)).toEqual([]);
    setRuntimeConfig(null);
  });
});

describe('visibleCommands caps', () => {
  it('lists every matching Create action but caps pages', () => {
    const many = (group: PaletteCommand['group'], n: number): PaletteCommand[] =>
      Array.from({ length: n }, (_, i) => ({ id: `${group}:${i}`, title: `Create thing ${i}`, subtitle: '', keywords: '', group, showWhenEmpty: false, icon }));
    const shown = visibleCommands([...many('actions', 20), ...many('navigation', 20)], 'create');
    expect(shown.filter((command) => command.group === 'actions')).toHaveLength(20);
    expect(shown.filter((command) => command.group === 'navigation')).toHaveLength(12);
  });
});

describe('Create action matching', () => {
  const commands = createCommands(en, {
    canSee: () => true,
    installedCodes: new Set(['welddocs', 'weldforms', 'weldcommerce', 'weldstash', 'weldcrm', 'weldads', 'weldmail']),
  });
  const ids = (query: string) => visibleCommands(commands, query).map((command) => command.id);

  it('does not list every Create action for a fragment of a create word or the title verb', () => {
    for (const fragment of ['re', 'ate', 'sta', 'art', 'ma', 'ne', 'ken']) {
      expect(ids(fragment).length, fragment).toBeLessThan(3);
    }
    expect(ids('ad')).toEqual(['create:ad-campaign']);
  });

  it('still finds them by a create word or its start, in either language', () => {
    expect(ids('create')).toHaveLength(commands.length);
    expect(ids('cre')).toHaveLength(commands.length);
    expect(ids('nieuw')).toHaveLength(commands.length);
    expect(ids('new doc')).toEqual(['create:document']);
    expect(ids('aanmaken formulier')).toEqual(['create:form']);
    expect(ids('e-mail')).toEqual(['create:email']);
  });
});
