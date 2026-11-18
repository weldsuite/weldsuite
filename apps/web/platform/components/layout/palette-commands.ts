/**
 * Command catalog for the centered Cmd/Ctrl+K palette.
 *
 * Empty state is an app switcher plus the current app's Create actions.
 * Typing filters every Create action, page and settings page. Record search
 * stays outside this module.
 *
 * Permissions are checked in the app a command opens, not the app the member
 * is in: a WeldDocs page listed while in WeldCRM needs the WeldDocs grant.
 */

import type { ComponentType } from 'react';
import { getAppsForObject, normalizeAppCode } from '@weldsuite/permissions';
import {
  Activity,
  AlertCircle,
  AppWindow,
  Archive,
  BarChart3,
  Bell,
  BookCheck,
  Bookmark,
  Bot,
  Building,
  Building2,
  CalendarDays,
  CalendarPlus,
  ChartSpline,
  CheckSquare,
  CircleDot,
  ClipboardList,
  Clock,
  CreditCard,
  File,
  FileText,
  FolderPlus,
  Globe,
  Inbox,
  KeyRound,
  Fingerprint,
  Sparkles,
  Hash,
  History,
  Home,
  Keyboard,
  LayoutTemplate,
  List,
  LogOut,
  Mail,
  MailX,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Moon,
  NotebookPen,
  NotebookText,
  Package,
  PanelsTopLeft,
  PenLine,
  Phone,
  Plug,
  Receipt,
  ScrollText,
  Send,
  SendHorizontal,
  Settings,
  Shield,
  ShieldCheck,
  ShoppingCart,
  Signature,
  SlidersHorizontal,
  SquareCheck,
  SquareDashedMousePointer,
  Star,
  Store,
  Sun,
  SunMoon,
  Table2,
  Target,
  Trash2,
  UserPlus,
  Users,
  UsersRound,
  Variable,
  Video,
  Warehouse,
  Webhook,
  Workflow,
} from 'lucide-react';
import type { TranslationsType } from '@/lib/i18n/types';
import { isFeatureAvailable, isModuleOffered } from '@/lib/edition';
import { isHrefOffered, isRouteOffered } from '@/lib/edition-routes';
import { withCreateIntent } from '@/hooks/use-create-intent';
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
  /**
   * Words shared by many commands (the create verbs). When set, the command
   * matches on word starts instead of anywhere in its text, and a query word
   * finds it through these only from three letters, so "re" or "ad" doesn't
   * list every Create action.
   */
  sharedWords?: string;
}

/** What the signed-in member can do, and which apps this workspace has installed. */
export interface CommandAccess {
  /**
   * Whether the member holds `permission` in `app` (an app code); with no app,
   * in any app. Unset permissions pass.
   */
  canSee: (permission: string | undefined, app?: string | null) => boolean;
  installedCodes: ReadonlySet<string>;
  /** The app the member is in (`appFromPathname`), whose Create actions show before typing. */
  currentApp?: string | null;
  /** An app's display name, shown next to its Create actions. */
  appName?: (appCode: string) => string | undefined;
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

/**
 * The fixed pages of modules whose sidebar is built by a hook (their
 * `MODULE_CONFIGS` entry has no static menu): the same titles and links as
 * those hooks, without the per-user parts (mail accounts, chat channels,
 * projects, spaces, calendars). Mail folders open the all-accounts view.
 */
const CUSTOM_SIDEBAR_PAGES: Partial<Record<string, (t: TranslationsType) => SidebarPage[]>> = {
  // app/weldmail/hooks/use-mail-sidebar-items.tsx
  weldmail: (t) => {
    const m = t.mail.sidebar;
    return [
      { title: m.inbox, href: '/weldmail/unified/inbox', icon: Inbox },
      { title: m.starred, href: '/weldmail/unified/starred', icon: Star },
      { title: m.sent, href: '/weldmail/unified/sent', icon: SendHorizontal },
      { title: m.drafts, href: '/weldmail/unified/drafts', icon: File },
      { title: m.scheduled, href: '/weldmail/unified/scheduled', icon: CalendarDays },
      { title: m.snoozed, href: '/weldmail/unified/snoozed', icon: Clock },
      { title: m.important, href: '/weldmail/unified/important', icon: AlertCircle },
      { title: m.allMail, href: '/weldmail/unified/all', icon: Mail },
      { title: m.archive, href: '/weldmail/unified/archive', icon: Archive },
      { title: m.spam, href: '/weldmail/unified/spam', icon: AlertCircle },
      { title: m.trash, href: '/weldmail/unified/trash', icon: Trash2 },
      { title: m.subscriptions, href: '/weldmail/subscriptions', icon: MailX },
    ];
  },
  // app/weldflow/hooks/use-projects-sidebar-items.tsx
  weldflow: (t) => {
    const p = t.projects.sidebar;
    return [
      { title: p.myTasks, href: '/weldflow', icon: SquareCheck },
      { title: p.myReviews, href: '/weldflow/reviews', icon: Inbox },
      { title: p.allProjects, href: '/weldflow/projects', icon: PanelsTopLeft },
      { title: p.workload, href: '/weldflow/workload', icon: Users },
      { title: p.intake, href: '/weldflow/intake', icon: Inbox, permission: 'portfolio:read' },
      { title: p.analytics, href: '/weldflow/analytics', icon: BarChart3 },
    ];
  },
  // app/weldcalendar/hooks/use-calendar-sidebar-items.tsx
  weldcalendar: (t) => [
    { title: t.weldcalendar.calendarSidebar.bookingPages, href: '/weldcalendar/scheduling', icon: CalendarDays },
  ],
  // app/weldchat/hooks/use-weldchat-sidebar-items.tsx
  weldchat: (t) => [
    { title: t.weldchat.activity, href: '/weldchat/activity', icon: Activity },
    { title: t.weldchat.drafts, href: '/weldchat/drafts', icon: PenLine },
    { title: t.weldchat.directories, href: '/weldchat/directories', icon: Users },
    { title: t.sweep.weldchat.recordChats.title, href: '/weldchat/records', icon: MessagesSquare },
    { title: t.sweep.weldchat.sidebar.savedItems, href: '/weldchat/bookmarks', icon: Bookmark },
  ],
  // app/weldconnect/hooks/use-weldconnect-sidebar-items.tsx
  weldconnect: (t) => {
    const wc = t.navigation.moduleSidebar.weldconnect;
    return [
      { title: wc.overview, href: '/weldconnect', icon: Home },
      { title: wc.workflows, href: '/weldconnect/workflows', icon: Workflow },
      { title: wc.executions, href: '/weldconnect/executions', icon: History },
      { title: wc.templates, href: '/weldconnect/templates', icon: LayoutTemplate },
      { title: wc.integrations, href: '/weldconnect/integrations', icon: Plug },
      { title: wc.variables, href: '/weldconnect/variables', icon: Variable },
      { title: wc.webhooks, href: '/weldconnect/webhooks', icon: Webhook },
      { title: wc.analytics, href: '/weldconnect/analytics', icon: BarChart3 },
    ];
  },
};

/**
 * Every page in a module's sidebar menu, with the permission that gates it.
 * `isHrefVisible` applies a module's own visibility rule (WeldBooks hides pages
 * by the entity's country), the same one its sidebar uses.
 */
export function pagesForModule(
  appCode: string,
  t: TranslationsType,
  options: { isHrefVisible?: (href: string) => boolean } = {},
): SidebarPage[] {
  const isHrefVisible = options.isHrefVisible ?? (() => true);
  const config = MODULE_CONFIGS[appCode];
  if (!config) return [];
  const pages: SidebarPage[] = (CUSTOM_SIDEBAR_PAGES[appCode]?.(t) ?? []).filter((page) => isHrefVisible(page.href));
  for (const group of config.getMenuItems(t)) {
    for (const item of group.items) {
      // A hidden item takes its sub-items with it, like in the sidebar.
      if (!isHrefVisible(item.href)) continue;
      pages.push({
        title: item.title,
        href: item.href,
        permission: item.permission,
        icon: item.icon,
      });
      for (const sub of item.subItems ?? []) {
        if (!isHrefVisible(sub.href)) continue;
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

/**
 * An entry per installed app, plus one per sidebar page the member may open
 * in that app.
 */
export function navigationCommandsForApps(
  apps: InstalledAppRef[],
  pagesForApp: (appCode: string) => SidebarPage[],
  iconForApp: (appCode: string) => PaletteIcon,
  canSee: CommandAccess['canSee'],
): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  const seenApps = new Set<string>();

  for (const app of apps) {
    if (seenApps.has(app.appCode)) continue;
    seenApps.add(app.appCode);

    const root = appHref(app);
    // Edition flags (4.F3): a module's menu may link into one this deployment doesn't serve.
    const canSeeInApp = (permission: string) => canSee(permission, app.appCode);
    const pages = pagesForApp(app.appCode).filter(
      (page) => menuPermissionAllows(page.permission, canSeeInApp) && isHrefOffered(page.href),
    );
    const rootPage = pages.find((page) => page.href === root);

    commands.push({
      id: `nav:${app.appCode}`,
      title: app.name,
      subtitle: '',
      keywords: `${app.name} ${app.appCode} home open go ${rootPage?.title ?? ''}`,
      group: 'navigation',
      showWhenEmpty: true,
      href: root,
      // A hook-built sidebar's first page ("My tasks", "Overview") doesn't stand for the app.
      icon: (!CUSTOM_SIDEBAR_PAGES[app.appCode] && rootPage?.icon) || iconForApp(app.appCode),
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

/** Companies and people are WeldCRM's API, whichever installed app lists them (edition flags, 4.F3). */
function workspaceHasObject(object: string, installedCodes: ReadonlySet<string>): boolean {
  return isModuleOffered('crm') && getAppsForObject(object).some((code) => installedCodes.has(code));
}

/** WeldAgent is on the rail, not installed: it is there whenever the edition offers it. */
const AGENTS_APP = 'agents';

/** The Create titles of any locale (each locale types its strings as literals). */
type CreateCopy = Readonly<Record<keyof TranslationsType['sweep']['shared']['commandPalette']['create'], string>>;

/**
 * A Create action: a link into the app that owns the record, to a page that
 * starts its own "new" flow (`?new=…`, see `useCreateIntent`, or a dedicated
 * `…/new` page). The flow runs inside that app, so its providers, permission
 * scope and `X-Weld-App` are the right ones.
 */
interface CreateAction {
  id: string;
  /** Installed app code (`agents` for WeldAgent). */
  app: string;
  /** Shown when the member holds any one of these in `app`. */
  permissions: readonly string[];
  title: (copy: CreateCopy) => string;
  /** Search words besides the title, in English and Dutch. */
  keywords: string;
  href: string;
  icon: PaletteIcon;
  /** Extra edition or feature condition. */
  available?: () => boolean;
}

/** Words that find every Create action. */
const CREATE_WORDS = 'create new add make nieuw nieuwe aanmaken toevoegen maken';

export const CREATE_ACTIONS: readonly CreateAction[] = [
  // WeldCRM (companies and people use the quick-add dialogs above)
  { id: 'crm-task', app: 'weldcrm', permissions: ['tasks:create'], title: (c) => c.task, keywords: 'task todo taak', href: withCreateIntent('/weldcrm'), icon: CheckSquare },
  { id: 'crm-note', app: 'weldcrm', permissions: ['activities:create'], title: (c) => c.note, keywords: 'note notitie', href: withCreateIntent('/weldcrm/notes'), icon: NotebookPen },
  // Communication
  { id: 'email', app: 'weldmail', permissions: ['messages:create'], title: (c) => c.email, keywords: 'email mail compose send message e-mail opstellen versturen', href: '/weldmail/inbox/compose', icon: Mail },
  { id: 'call', app: 'weldcall', permissions: ['activities:create'], title: (c) => c.call, keywords: 'call phone dial bellen telefoon', href: '/weldcall/new', icon: Phone },
  { id: 'chat-channel', app: 'weldchat', permissions: ['channels:create'], title: (c) => c.channel, keywords: 'channel chat kanaal', href: withCreateIntent('/weldchat', 'channel'), icon: Hash },
  { id: 'chat-dm', app: 'weldchat', permissions: ['messages:create'], title: (c) => c.directMessage, keywords: 'direct message dm chat bericht', href: withCreateIntent('/weldchat', 'dm'), icon: MessageSquare },
  { id: 'meeting', app: 'weldmeet', permissions: ['meetings:create'], title: (c) => c.meeting, keywords: 'meeting video call vergadering', href: '/weldmeet/new', icon: Video },
  { id: 'event', app: 'weldcalendar', permissions: ['events:create'], title: (c) => c.event, keywords: 'event calendar appointment afspraak agenda', href: withCreateIntent('/weldcalendar'), icon: CalendarPlus },
  { id: 'booking-page', app: 'weldcalendar', permissions: ['bookings:create'], title: (c) => c.bookingPage, keywords: 'booking page scheduling link boekingspagina', href: '/weldcalendar/scheduling/new', icon: CalendarDays },
  // Documents
  { id: 'document', app: 'welddocs', permissions: ['docs:create'], title: (c) => c.document, keywords: 'document doc', href: withCreateIntent('/welddocs'), icon: NotebookText },
  { id: 'sheet', app: 'weldsheets', permissions: ['sheets:create'], title: (c) => c.sheet, keywords: 'spreadsheet sheet rekenblad', href: withCreateIntent('/weldsheets'), icon: Table2 },
  { id: 'board', app: 'weldboard', permissions: ['boards:create'], title: (c) => c.board, keywords: 'board whiteboard bord', href: withCreateIntent('/weldboard'), icon: SquareDashedMousePointer },
  { id: 'form', app: 'weldforms', permissions: ['forms:create'], title: (c) => c.form, keywords: 'form survey formulier enquête', href: withCreateIntent('/weldforms'), icon: ClipboardList },
  { id: 'sign-request', app: 'weldsign', permissions: ['sign_envelopes:create'], title: (c) => c.signRequest, keywords: 'signature sign envelope request handtekening ondertekenen', href: withCreateIntent('/weldsign'), icon: Signature },
  { id: 'knowledge-page', app: 'weldknow', permissions: ['knowledge:create'], title: (c) => c.knowledgePage, keywords: 'knowledge page wiki kennis pagina', href: withCreateIntent('/weldknow'), icon: ScrollText },
  { id: 'folder', app: 'welddrive', permissions: ['folders:create'], title: (c) => c.folder, keywords: 'folder drive map', href: withCreateIntent('/welddrive', 'folder'), icon: FolderPlus },
  // Projects and automation
  { id: 'flow-task', app: 'weldflow', permissions: ['tasks:create'], title: (c) => c.task, keywords: 'task todo taak', href: withCreateIntent('/weldflow'), icon: SquareCheck },
  { id: 'flow-project', app: 'weldflow', permissions: ['projects:create'], title: (c) => c.project, keywords: 'project', href: withCreateIntent('/weldflow/projects'), icon: PanelsTopLeft },
  { id: 'workflow', app: 'weldconnect', permissions: ['workflows:create'], title: (c) => c.workflow, keywords: 'workflow automation automatisering', href: withCreateIntent('/weldconnect/workflows'), icon: Workflow },
  // Sales and stock
  { id: 'product', app: 'weldcommerce', permissions: ['products:create'], title: (c) => c.product, keywords: 'product artikel', href: withCreateIntent('/weldcommerce/products'), icon: Package },
  { id: 'order', app: 'weldcommerce', permissions: ['orders:create'], title: (c) => c.order, keywords: 'order sale bestelling', href: withCreateIntent('/weldcommerce/orders'), icon: ShoppingCart },
  { id: 'stash-product', app: 'weldstash', permissions: ['products:create'], title: (c) => c.product, keywords: 'product artikel stock voorraad', href: withCreateIntent('/weldstash/products'), icon: Package },
  { id: 'warehouse', app: 'weldstash', permissions: ['warehouses:create'], title: (c) => c.warehouse, keywords: 'warehouse location magazijn', href: withCreateIntent('/weldstash/warehouses'), icon: Warehouse },
  { id: 'invoice', app: 'weldbooks', permissions: ['invoices:create'], title: (c) => c.invoice, keywords: 'invoice sales factuur verkoopfactuur', href: '/weldbooks/invoices/add', icon: FileText },
  { id: 'bill', app: 'weldbooks', permissions: ['bills:create'], title: (c) => c.bill, keywords: 'bill purchase invoice inkoopfactuur', href: '/weldbooks/bills/add', icon: Receipt },
  { id: 'journal-entry', app: 'weldbooks', permissions: ['journal:create'], title: (c) => c.journalEntry, keywords: 'journal entry booking memoriaal boeking', href: '/weldbooks/journal/add', icon: BookCheck },
  // Support, marketing and the rest
  { id: 'announcement', app: 'welddesk', permissions: ['articles:create'], title: (c) => c.announcement, keywords: 'announcement help center aankondiging', href: '/welddesk/help-center/announcements/new', icon: Megaphone },
  { id: 'social-post', app: 'social', permissions: ['posts:create'], title: (c) => c.socialPost, keywords: 'social post bericht', href: withCreateIntent('/social'), icon: Send },
  { id: 'ad-campaign', app: 'weldads', permissions: ['ad_campaigns:create'], title: (c) => c.adCampaign, keywords: 'ad ads advertising campaign advertentie campagne', href: withCreateIntent('/weldads/campaigns'), icon: Target },
  { id: 'outreach-campaign', app: 'weldreach', permissions: ['reach_campaigns:create'], title: (c) => c.outreachCampaign, keywords: 'outreach campaign cold email campagne', href: withCreateIntent('/weldreach/campaigns'), icon: Send },
  { id: 'lead-list', app: 'welddata', permissions: ['prospects:create'], title: (c) => c.leadList, keywords: 'lead list prospects leadlijst lijst', href: withCreateIntent('/welddata'), icon: List },
  { id: 'analytics-project', app: 'weldpanel', permissions: ['panel_projects:create'], title: (c) => c.analyticsProject, keywords: 'analytics project tracking analyse', href: withCreateIntent('/weldpanel/projects'), icon: ChartSpline },
  { id: 'issue', app: 'weldmerge', permissions: ['merge_issues:create'], title: (c) => c.issue, keywords: 'issue bug git', href: withCreateIntent('/weldmerge/issues'), icon: CircleDot },
  { id: 'employee', app: 'weldhr', permissions: ['employees:create', 'employees:manage'], title: (c) => c.employee, keywords: 'employee staff hire medewerker werknemer personeel', href: withCreateIntent('/weldhr/employees'), icon: UsersRound },
  {
    id: 'domain',
    app: 'weldhost',
    permissions: ['domains:create'],
    title: (c) => (isFeatureAvailable('domain-purchase') ? c.registerDomain : c.addDomain),
    keywords: 'domain dns register domein registreren',
    href: '/weldhost/domains/register',
    icon: Globe,
    available: () => isFeatureAvailable('domain-purchase'),
  },
  {
    id: 'external-domain',
    app: 'weldhost',
    permissions: ['domains:create'],
    title: (c) => c.addDomain,
    keywords: 'domain dns external connect domein extern koppelen',
    href: '/weldhost/domains/external',
    icon: Globe,
    available: () => !isFeatureAvailable('domain-purchase'),
  },
  { id: 'agent', app: AGENTS_APP, permissions: ['weldagent:create', 'weldagent:manage'], title: (c) => c.agent, keywords: 'agent ai assistant bot', href: withCreateIntent('/agents'), icon: Bot },
];

function isAppPresent(app: string, installedCodes: ReadonlySet<string>): boolean {
  return app === AGENTS_APP ? isModuleOffered('agent') : installedCodes.has(app);
}

function sameApp(a: string | null | undefined, b: string): boolean {
  return !!a && normalizeAppCode(a) === normalizeAppCode(b);
}

/**
 * The Create actions the member may run: the app is installed (and served by
 * this edition), the target page is offered, and the member holds the create
 * permission in that app. Before typing, only the current app's show.
 */
export function createCommands(t: TranslationsType, access: CommandAccess): PaletteCommand[] {
  const copy = t.sweep.shared.commandPalette.create;
  return CREATE_ACTIONS.filter(
    (action) =>
      isAppPresent(action.app, access.installedCodes) &&
      isHrefOffered(action.href) &&
      (action.available?.() ?? true) &&
      action.permissions.some((permission) => access.canSee(permission, action.app)),
  ).map((action) => {
    const appName = access.appName?.(action.app) ?? '';
    return {
      id: `create:${action.id}`,
      title: action.title(copy),
      subtitle: appName,
      keywords: `${action.keywords} ${appName} ${action.app}`,
      sharedWords: CREATE_WORDS,
      group: 'actions' as const,
      showWhenEmpty: sameApp(access.currentApp, action.app),
      href: action.href,
      icon: action.icon,
    };
  });
}

export function actionCommands(
  t: TranslationsType,
  resolvedTheme: 'light' | 'dark',
  access?: CommandAccess,
): PaletteCommand[] {
  const copy = t.sweep.shared.commandPalette;
  const toDark = resolvedTheme !== 'dark';
  const commands: PaletteCommand[] = [];

  // Shown before typing outside an app (home) and in the apps that list the record.
  const crmRecordsHere = (object: string) =>
    !access?.currentApp || getAppsForObject(object).some((code) => sameApp(access.currentApp, code));

  if (access && workspaceHasObject('companies', access.installedCodes) && access.canSee('companies:create')) {
    commands.push({
      id: 'action:create-company',
      title: t.companies.actions.create,
      subtitle: '',
      keywords: 'create company companies customer new add bedrijf bedrijven klant toevoegen aanmaken',
      group: 'actions',
      showWhenEmpty: crmRecordsHere('companies'),
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
      showWhenEmpty: crmRecordsHere('people'),
      run: 'create-person',
      icon: UserPlus,
    });
  }
  if (access) commands.push(...createCommands(t, access));

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

/** WeldAgent, listed after the installed apps like on the rail (when the edition offers it). */
export function agentNavigationCommands(t: TranslationsType): PaletteCommand[] {
  if (!isModuleOffered('agent')) return [];
  return [
    {
      id: 'nav:agents',
      title: t.navigation.aiAgents,
      subtitle: '',
      keywords: 'weldagent agents ai assistant bot',
      group: 'navigation',
      showWhenEmpty: true,
      href: '/agents',
      icon: Bot,
    },
  ];
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
      id: 'settings-sso',
      title: menu.sso,
      subtitle: settingsTitle,
      keywords: `${menu.sso} ${search.sso} sso saml okta entra identity provider`,
      href: '/settings/sso',
      icon: Fingerprint,
    },
    {
      id: 'settings-ai',
      title: menu.ai,
      subtitle: settingsTitle,
      keywords: `${menu.ai} ${search.ai} ai mistral claude chatgpt provider model openai anthropic`,
      href: '/settings/ai',
      icon: Sparkles,
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
    { code: 'weldmerge', title: 'WeldMerge', keywords: 'weldmerge git providers repositories teams labels settings', href: '/settings/apps/weldmerge' },
    { code: 'weldreach', title: 'WeldReach', keywords: 'weldreach outreach sender sending defaults suppressions settings', href: '/settings/apps/weldreach' },
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

  // Edition flags (4.F3): only settings pages this deployment serves.
  return links
    .filter((link) => !link.href || isRouteOffered(link.href))
    .map((link) => ({
      ...link,
      group: 'settings' as const,
      showWhenEmpty: link.showWhenEmpty ?? false,
    }));
}

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Shared words count only from this many letters. */
const SHARED_WORD_MIN = 3;

export function commandMatches(
  command: Pick<PaletteCommand, 'title' | 'subtitle' | 'keywords' | 'sharedWords'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const text = `${command.title} ${command.subtitle} ${command.keywords}`;
  if (command.sharedWords === undefined) {
    const hay = text.toLowerCase();
    return q.split(/\s+/).filter(Boolean).every((token) => hay.includes(token));
  }
  const own = words(text);
  const shared = words(command.sharedWords);
  const tokens = words(q);
  return (
    tokens.length > 0 &&
    tokens.every(
      (token) =>
        own.some((word) => word.startsWith(token)) ||
        (token.length >= SHARED_WORD_MIN && shared.some((word) => word.startsWith(token))),
    )
  );
}

function rank(command: PaletteCommand, query: string): number {
  const title = command.title.toLowerCase();
  if (title === query) return 3;
  if (title.startsWith(query)) return 2;
  if (title.includes(query)) return 1;
  return 0;
}

/**
 * Empty query returns the switcher. A query returns the best matches, capped
 * per group; actions are not capped, so "create" lists every Create action.
 */
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
    if (command.group !== 'actions' && count >= perGroupLimit) continue;
    counts.set(command.group, count + 1);
    out.push(command);
  }
  return out;
}
