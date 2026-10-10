/**
 * Command catalog for the centered Cmd/Ctrl+K palette.
 *
 * Empty state is an app switcher plus a few actions. Typing filters pages
 * and settings. Record search stays outside this module.
 */

import type { ComponentType } from 'react';
import { getAppsForObject } from '@weldsuite/permissions';
import {
  AppWindow,
  Bell,
  Building,
  Building2,
  CreditCard,
  History,
  Home,
  Keyboard,
  KeyRound,
  LayoutTemplate,
  LogOut,
  Monitor,
  Moon,
  Phone,
  Plug,
  Receipt,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Store,
  Sun,
  SunMoon,
  UserPlus,
  Users,
  Webhook,
} from 'lucide-react';
import type { TranslationsType } from '@/lib/i18n/types';
import { menuPermissionAllows, type MenuPermission } from './menu-permission';
import { MODULE_CONFIGS } from './module-sidebar-configs';

export type PaletteIcon = ComponentType<{ className?: string }>;
export type PaletteGroup = 'actions' | 'navigation' | 'settings';

export interface PaletteCommand {
  id: string;
  title: string;
  subtitle: string;
  keywords: string;
  group: PaletteGroup;
  /** Listed before the user types. */
  showWhenEmpty: boolean;
  href?: string;
  run?: 'toggle-theme' | 'sign-out' | 'create-company' | 'create-person';
  icon: PaletteIcon;
}

/** What the signed-in member can do, and which apps this workspace has installed. */
export interface CommandAccess {
  canSee: (permission: string | undefined) => boolean;
  installedCodes: ReadonlySet<string>;
}

export interface InstalledAppRef {
  appCode: string;
  name: string;
  appType?: 'system' | 'user' | 'object';
}

export interface SidebarPage {
  title: string;
  href: string;
  permission?: MenuPermission;
  icon: PaletteIcon;
}

export function appHref(app: InstalledAppRef): string {
  if (app.appType === 'user') return `/apps/${app.appCode}`;
  if (app.appType === 'object') return `/objects/${app.appCode}`;
  return `/${app.appCode}`;
}

/** Every page in a module's static sidebar menu, with the permission that gates it. */
export function pagesForModule(appCode: string, t: TranslationsType): SidebarPage[] {
  const config = MODULE_CONFIGS[appCode];
  if (!config) return [];
  const pages: SidebarPage[] = [];
  for (const group of config.getMenuItems(t)) {
    for (const item of group.items) {
      pages.push({
        title: item.title,
        href: item.href,
        permission: item.permission,
        icon: item.icon,
      });
      for (const sub of item.subItems ?? []) {
        pages.push({
          title: sub.title,
          href: sub.href,
          permission: sub.permission,
          icon: sub.icon,
        });
      }
    }
  }
  return pages;
}

/** An entry per installed app, plus one per sidebar page the member may open. */
export function navigationCommandsForApps(
  apps: InstalledAppRef[],
  pagesForApp: (appCode: string) => SidebarPage[],
  iconForApp: (appCode: string) => PaletteIcon,
  canSee: (permission: string | undefined) => boolean,
): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  const seenApps = new Set<string>();

  for (const app of apps) {
    if (seenApps.has(app.appCode)) continue;
    seenApps.add(app.appCode);

    const root = appHref(app);
    const pages = pagesForApp(app.appCode).filter((page) => menuPermissionAllows(page.permission, canSee));
    const rootPage = pages.find((page) => page.href === root);

    commands.push({
      id: `nav:${app.appCode}`,
      title: app.name,
      subtitle: '',
      keywords: `${app.name} ${app.appCode} home open go ${rootPage?.title ?? ''}`,
      group: 'navigation',
      showWhenEmpty: true,
      href: root,
      icon: rootPage?.icon ?? iconForApp(app.appCode),
    });

    const seenPages = new Set<string>();
    for (const page of pages) {
      if (page.href === root && page.title === app.name) continue;
      const key = `${page.href}|${page.title}`;
      if (seenPages.has(key)) continue;
      seenPages.add(key);
      commands.push({
        id: `nav:${app.appCode}:${page.href}:${page.title}`,
        title: page.title,
        subtitle: app.name,
        keywords: `${app.name} ${app.appCode} ${page.title} ${page.href}`,
        group: 'navigation',
        showWhenEmpty: false,
        href: page.href,
        icon: page.icon,
      });
    }
  }

  return commands;
}

function workspaceHasObject(object: string, installedCodes: ReadonlySet<string>): boolean {
  return getAppsForObject(object).some((code) => installedCodes.has(code));
}

export function actionCommands(
  t: TranslationsType,
  resolvedTheme: 'light' | 'dark',
  access?: CommandAccess,
): PaletteCommand[] {
  const copy = t.sweep.shared.commandPalette;
  const toDark = resolvedTheme !== 'dark';
  const commands: PaletteCommand[] = [];

  if (access && workspaceHasObject('companies', access.installedCodes) && access.canSee('companies:create')) {
    commands.push({
      id: 'action:create-company',
      title: t.companies.actions.create,
      subtitle: '',
      keywords: 'create company companies customer new add bedrijf bedrijven klant toevoegen aanmaken',
      group: 'actions',
      showWhenEmpty: true,
      run: 'create-company',
      icon: Building2,
    });
  }
  if (access && workspaceHasObject('people', access.installedCodes) && access.canSee('people:create')) {
    commands.push({
      id: 'action:create-person',
      title: t.people.actions.create,
      subtitle: '',
      keywords: 'create person people new add persoon personen toevoegen aanmaken',
      group: 'actions',
      showWhenEmpty: true,
      run: 'create-person',
      icon: UserPlus,
    });
  }

  commands.push(
    {
      id: 'action:theme',
      title: toDark ? copy.switchToDark : copy.switchToLight,
      subtitle: copy.themeHint,
      keywords: 'theme dark light mode appearance night donker licht',
      group: 'actions',
      showWhenEmpty: true,
      run: 'toggle-theme',
      icon: toDark ? Moon : Sun,
    },
    {
      id: 'action:sign-out',
      title: t.sweep.shared.signOut,
      subtitle: copy.signOutHint,
      keywords: 'sign out logout log out uitloggen session',
      group: 'actions',
      showWhenEmpty: false,
      run: 'sign-out',
      icon: LogOut,
    },
  );
  return commands;
}

export function extraNavigationCommands(t: TranslationsType): PaletteCommand[] {
  return [
    {
      id: 'nav:home',
      title: t.navigation.home,
      subtitle: 'WeldSuite',
      keywords: 'home dashboard start weldsuite',
      group: 'navigation',
      showWhenEmpty: true,
      href: '/',
      icon: Home,
    },
    {
      id: 'nav:appstore',
      title: t.navigation.appStore,
      subtitle: 'WeldSuite',
      keywords: 'app store apps install marketplace',
      group: 'navigation',
      showWhenEmpty: false,
      href: '/appstore',
      icon: Store,
    },
  ];
}

export function settingsCommands(
  t: TranslationsType,
  installed: ReadonlySet<string>,
  opts?: { includeDesktop?: boolean },
): PaletteCommand[] {
  const menu = t.settings.menu;
  const search = t.settings.search;
  const settingsTitle = t.settings.title;
  const copy = t.sweep.shared.commandPalette;

  const links: Array<Omit<PaletteCommand, 'group' | 'showWhenEmpty'> & { showWhenEmpty?: boolean }> = [
    {
      id: 'settings',
      title: settingsTitle,
      subtitle: search.profile,
      keywords: `settings ${menu.profile} ${search.profile} preferences`,
      href: '/settings',
      icon: Settings,
      showWhenEmpty: true,
    },
    {
      id: 'settings-appearance',
      title: menu.appearance,
      subtitle: settingsTitle,
      keywords: `${menu.appearance} ${search.appearance} theme dark light`,
      href: '/settings/appearance',
      icon: SunMoon,
    },
    {
      id: 'settings-notifications',
      title: menu.notifications,
      subtitle: settingsTitle,
      keywords: `${menu.notifications} ${search.notifications}`,
      href: '/settings/notifications',
      icon: Bell,
    },
    {
      id: 'settings-shortcuts',
      title: menu.shortcuts,
      subtitle: settingsTitle,
      keywords: `${menu.shortcuts} ${menu.keyboardShortcuts} keyboard`,
      href: '/settings/shortcuts',
      icon: Keyboard,
    },
    {
      id: 'settings-security',
      title: menu.security,
      subtitle: settingsTitle,
      keywords: `${menu.security} ${search.security}`,
      href: '/settings/security',
      icon: Shield,
    },
    {
      id: 'settings-team',
      title: menu.teamMembers,
      subtitle: settingsTitle,
      keywords: `${menu.teamMembers} ${search.teamMembers} invite members`,
      href: '/settings/team',
      icon: Users,
    },
    {
      id: 'settings-roles',
      title: copy.roles,
      subtitle: settingsTitle,
      keywords: `${copy.roles} permissions access`,
      href: '/settings/roles',
      icon: ShieldCheck,
    },
    {
      id: 'settings-plans',
      title: menu.plans,
      subtitle: settingsTitle,
      keywords: `${menu.plans} ${search.plans} subscription`,
      href: '/settings/plans',
      icon: CreditCard,
    },
    {
      id: 'settings-billing',
      title: menu.billing,
      subtitle: settingsTitle,
      keywords: `${menu.billing} ${search.billing} invoice payment`,
      href: '/settings/billing',
      icon: Receipt,
    },
    {
      id: 'settings-business',
      title: menu.businessSettings,
      subtitle: settingsTitle,
      keywords: `${menu.businessSettings} ${search.businessSettings} company`,
      href: '/settings/business',
      icon: Building,
    },
    {
      id: 'settings-api-keys',
      title: menu.apiKeys,
      subtitle: settingsTitle,
      keywords: `${menu.apiKeys} ${search.apiKeys}`,
      href: '/settings/api-keys',
      icon: KeyRound,
    },
    {
      id: 'settings-webhooks',
      title: menu.webhooks,
      subtitle: settingsTitle,
      keywords: `${menu.webhooks} ${search.webhooks}`,
      href: '/settings/webhooks',
      icon: Webhook,
    },
    {
      id: 'settings-custom-fields',
      title: menu.customFields,
      subtitle: settingsTitle,
      keywords: `${menu.customFields} ${search.customFields}`,
      href: '/settings/custom-fields',
      icon: SlidersHorizontal,
    },
    {
      id: 'settings-object-templates',
      title: menu.objectTemplates,
      subtitle: settingsTitle,
      keywords: `${menu.objectTemplates} ${search.objectTemplates}`,
      href: '/settings/object-templates',
      icon: LayoutTemplate,
    },
    {
      id: 'settings-integrations',
      title: menu.integrations,
      subtitle: settingsTitle,
      keywords: `${menu.integrations} ${search.integrations}`,
      href: '/settings/integrations',
      icon: Plug,
    },
    {
      id: 'settings-phone',
      title: menu.phoneNumbers,
      subtitle: settingsTitle,
      keywords: `${menu.phoneNumbers} ${search.phoneNumbers} voip`,
      href: '/settings/apps/phone-numbers',
      icon: Phone,
    },
    {
      id: 'settings-activity',
      title: menu.activityLog,
      subtitle: settingsTitle,
      keywords: `${menu.activityLog} ${search.activityLog} audit`,
      href: '/settings/activity',
      icon: History,
    },
    {
      id: 'settings-weldsuite',
      title: 'WeldSuite',
      subtitle: settingsTitle,
      keywords: 'weldsuite platform settings',
      href: '/settings/apps/weldsuite',
      icon: AppWindow,
    },
  ];

  if (opts?.includeDesktop) {
    links.push({
      id: 'settings-desktop',
      title: 'Desktop app',
      subtitle: settingsTitle,
      keywords: 'desktop electron app',
      href: '/settings/desktop',
      icon: Monitor,
    });
  }

  const appSettings: Array<{ code: string; title: string; keywords: string; href: string }> = [
    { code: 'parcel', title: search.parcelSettings, keywords: `${search.parcelSettings} ${search.configureParcel}`, href: '/settings/apps/parcel' },
    { code: 'weldcrm', title: 'WeldCRM', keywords: 'weldcrm crm settings', href: '/settings/apps/weldcrm' },
    { code: 'welddesk', title: search.helpdeskSettings, keywords: `${search.helpdeskSettings} ${search.configureHelpdesk}`, href: '/settings/apps/welddesk' },
    { code: 'weldmail', title: search.mailAccounts, keywords: `${search.mailAccounts} ${search.manageMailAccounts} weldmail`, href: '/settings/apps/weldmail' },
    { code: 'weldhr', title: search.weldhrSettings, keywords: `${search.weldhrSettings} ${search.configureWeldhr} weldhr`, href: '/settings/apps/weldhr' },
  ];
  for (const app of appSettings) {
    if (!installed.has(app.code)) continue;
    links.push({
      id: `settings-app:${app.code}`,
      title: app.title,
      subtitle: settingsTitle,
      keywords: app.keywords,
      href: app.href,
      icon: Settings,
    });
  }

  return links.map((link) => ({
    ...link,
    group: 'settings' as const,
    showWhenEmpty: link.showWhenEmpty ?? false,
  }));
}

export function commandMatches(
  command: Pick<PaletteCommand, 'title' | 'subtitle' | 'keywords'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const hay = `${command.title} ${command.subtitle} ${command.keywords}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((token) => hay.includes(token));
}

function rank(command: PaletteCommand, query: string): number {
  const title = command.title.toLowerCase();
  if (title === query) return 3;
  if (title.startsWith(query)) return 2;
  if (title.includes(query)) return 1;
  return 0;
}

/** Empty query returns the switcher. A query returns the best matches, capped per group. */
export function visibleCommands(
  commands: PaletteCommand[],
  query: string,
  perGroupLimit = 12,
): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.filter((command) => command.showWhenEmpty);

  const ranked = commands
    .filter((command) => commandMatches(command, q))
    .sort((a, b) => rank(b, q) - rank(a, q));

  const counts = new Map<PaletteGroup, number>();
  const out: PaletteCommand[] = [];
  for (const command of ranked) {
    const count = counts.get(command.group) ?? 0;
    if (count >= perGroupLimit) continue;
    counts.set(command.group, count + 1);
    out.push(command);
  }
  return out;
}
