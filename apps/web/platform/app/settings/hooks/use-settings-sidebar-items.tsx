import * as React from 'react';
import { usePathname, useRouter } from '@/lib/router';
import {
  CreditCard,
  SunMoon,
  Users,
  User,
  Building,
  Shield,
  ShieldCheck,
  Key,
  Fingerprint,
  Landmark,
  Scale,
  Keyboard,
  Receipt,
  Bell,
  SlidersHorizontal,
  LayoutTemplate,
  Phone,
  Plug,
  History,
  Monitor,
  Webhook,
  MessagesSquare,
  Mail,
  BookOpen,
  Bot,
  Tags,
  Shuffle,
  Timer,
  Database,
  Grid3x3,
  ConciergeBell,
  Laptop,
  Route,
  Sparkles,
  Globe,
} from 'lucide-react';
import { isDesktop } from '@/lib/desktop';
import { getAppLogo, getAppLucideIcon, resolveAppCode } from '@/lib/apps/app-registry';
import type { MenuGroupProps, MenuItemProps } from '@/components/app-sidebar-layout';
import type { TranslationsType } from '@/lib/i18n/types';
import { useInstalledApps } from '@/hooks/use-installed-apps';
import { useI18n } from '@/lib/i18n/provider';
import { isRouteOffered } from '@/lib/edition-routes';
import { isFeatureAvailable } from '@/lib/edition';
import { usePermissions } from '@weldsuite/permissions/react';

function makeAppLogoIcon(appCode: string, name: string) {
  return function AppLogoIcon({ className }: { className?: string }) {
    const logo = getAppLogo(appCode, 'light');
    if (logo) {
      return <img src={logo} alt={name} className={`${className ?? ''} grayscale opacity-70`} />;
    }
    const FallbackIcon = getAppLucideIcon(appCode);
    return <FallbackIcon className={className} />;
  };
}

// Every installed app with settings gets one entry here, at
// `/settings/apps/{appCode}`: this is the only place an app's settings are
// reached from (never the app's own sidebar or pages, see AGENTS.md).
// Built once so the icon components keep their identity across renders.
const APP_SETTINGS_ITEMS = [
  { appCode: 'weldbooks', title: 'WeldBooks', href: '/settings/apps/weldbooks' },
  { appCode: 'weldcalendar', title: 'WeldCalendar', href: '/settings/apps/weldcalendar' },
  { appCode: 'weldcrm', title: 'WeldCRM', href: '/settings/apps/weldcrm' },
  { appCode: 'welddesk', title: 'WeldDesk', href: '/settings/apps/welddesk' },
  { appCode: 'weldflow', title: 'WeldFlow', href: '/settings/apps/weldflow' },
  { appCode: 'weldforms', title: 'WeldForms', href: '/settings/apps/weldforms' },
  { appCode: 'weldhr', title: 'WeldHR', href: '/settings/apps/weldhr' },
  { appCode: 'weldmail', title: 'WeldMail', href: '/settings/apps/weldmail' },
  { appCode: 'weldcommerce', title: 'WeldCommerce', href: '/settings/apps/weldcommerce' },
  { appCode: 'weldstash', title: 'WeldStash', href: '/settings/apps/weldstash' },
  { appCode: 'weldmerge', title: 'WeldMerge', href: '/settings/apps/weldmerge' },
  { appCode: 'weldpass', title: 'WeldPass', href: '/settings/apps/weldpass' },
  { appCode: 'weldpanel', title: 'WeldPanel', href: '/settings/apps/weldpanel' },
  { appCode: 'weldreach', title: 'WeldReach', href: '/settings/apps/weldreach' },
  { appCode: 'social', title: 'WeldSocial', href: '/settings/apps/social' },
].map(({ appCode, title, href }) => ({ appCode, title, href, icon: makeAppLogoIcon(appCode, title) }));

/**
 * WeldDesk's settings pages, in the order and grouping of its overview page
 * (`app/settings/apps/welddesk/page.tsx`).
 */
function welddeskSettingsSubItems(
  td: TranslationsType['settings']['welddesk'],
  th: TranslationsType['helpdesk'],
  tb: TranslationsType['deskBi'],
): MenuItemProps[] {
  const items: MenuItemProps[] = [
    { title: td.chatWidgetTitle, href: '/settings/apps/welddesk/chat-widget', icon: MessagesSquare },
    { title: td.emailTitle, href: '/settings/apps/welddesk/email', icon: Mail },
    { title: td.phoneTitle, href: '/settings/apps/welddesk/phone', icon: Phone },
    { title: td.helpCenterTitle, href: '/settings/apps/welddesk/help-center', icon: BookOpen },
    { title: td.voiceAgentsTitle, href: '/settings/apps/welddesk/voice-agents', icon: Bot },
    { title: td.ticketTypesTitle, href: '/settings/apps/welddesk/ticket-types', icon: Tags },
    { title: th.teamsSettings.title, href: '/settings/apps/welddesk/teams', icon: Users },
    { title: th.routing.title, href: '/settings/apps/welddesk/routing', icon: Route },
    { title: td.assignmentTitle, href: '/settings/apps/welddesk/assignment', icon: Shuffle },
    { title: td.slaPoliciesTitle, href: '/settings/apps/welddesk/sla-policies', icon: Timer },
    { title: td.priorityMatrixTitle, href: '/settings/apps/welddesk/priority-matrix', icon: Grid3x3 },
    { title: td.serviceCatalogueTitle, href: '/settings/apps/welddesk/service-catalogue', icon: ConciergeBell },
    { title: th.assets.settingsTitle, href: '/settings/apps/welddesk/asset-register', icon: Laptop },
    { title: tb.title, href: '/settings/apps/welddesk/bi-connector', icon: Database },
  ];
  // Like the overview page: no links to pages this edition doesn't serve.
  return items.filter((item) => isRouteOffered(item.href));
}

// WeldSuite itself is always shown — it's the platform, not an installable app.
const WELDSUITE_SETTINGS_ITEM = {
  title: 'WeldSuite',
  href: '/settings/apps/weldsuite',
  icon: makeAppLogoIcon('weldsuite', 'WeldSuite'),
};

/**
 * Settings menu for the unified module sidebar (`MODULE_CONFIGS.settings`).
 * The Apps group lists the settings pages of installed apps, shown with the
 * app's own logo. The sidebar header is a back button that returns to the
 * page settings was opened from.
 */
export function useSettingsSidebarItems(enabled: boolean) {
  const { t } = useI18n();
  const ts = t.settings;
  const pathname = usePathname();
  const router = useRouter();
  const { data: apps } = useInstalledApps();
  const { can } = usePermissions();
  const canManageAi = can('ai:manage');

  const installedAppCodes = React.useMemo(
    // Canonical codes, so a workspace still on a legacy code (`accounting`, `commerce`) gets its entry.
    () => new Set((apps ?? []).filter((app) => app.status === 'active').map((app) => resolveAppCode(app.appCode))),
    [apps],
  );

  const hasEntityApps = installedAppCodes.has('weldbooks') || installedAppCodes.has('weldhr');

  const handleBack = React.useCallback(() => {
    const url = sessionStorage.getItem('settings-return-url') || '/';
    sessionStorage.removeItem('settings-return-url');
    router.push(url);
  }, [router]);

  const menuGroups = React.useMemo<MenuGroupProps[]>(() => {
    if (!enabled) return [];

    const appsItems = [
      WELDSUITE_SETTINGS_ITEM,
      ...APP_SETTINGS_ITEMS
        // WeldStash's settings (replenishment) exist on the Kubernetes editions only, WeldCommerce is Rust-only.
        .filter(
          (item) =>
            installedAppCodes.has(item.appCode) &&
            (item.appCode !== 'weldstash' || isFeatureAvailable('stash-replenishment')) &&
            (item.appCode !== 'weldcommerce' || isFeatureAvailable('commerce')) &&
            (item.appCode !== 'weldpass' || isFeatureAvailable('weldpass-offline')),
        )
        .map(({ appCode, title, href, icon }): MenuItemProps => ({
          title,
          href,
          icon,
          // WeldDesk opens up to its own settings pages while one of them is open.
          ...(appCode === 'welddesk' && (pathname ?? '').startsWith('/settings/apps/welddesk')
            ? { subItems: welddeskSettingsSubItems(ts.welddesk, t.helpdesk, t.deskBi) }
            : {}),
        })),
    ];

    const groups: MenuGroupProps[] = [
      {
        group: ts.general,
        items: [
          { title: ts.menu.profile, href: '/settings', icon: User, isActive: pathname === '/settings' },
          { title: ts.menu.appearance, href: '/settings/appearance', icon: SunMoon },
          { title: ts.menu.notifications, href: '/settings/notifications', icon: Bell },
          { title: ts.menu.shortcuts, href: '/settings/shortcuts', icon: Keyboard },
          { title: ts.menu.security, href: '/settings/security', icon: Shield },
          // Only visible inside the Electron desktop shell.
          ...(isDesktop() ? [{ title: ts.menu.desktopApp, href: '/settings/desktop', icon: Monitor }] : []),
        ],
      },
      {
        group: ts.menu.workspace,
        items: [
          { title: ts.menu.teamMembers, href: '/settings/team', icon: Users },
          { title: ts.roles.title, href: '/settings/roles', icon: ShieldCheck },
          { title: ts.menu.sso, href: '/settings/sso', icon: Fingerprint },
          // Kubernetes editions with AI configured (hidden elsewhere by the edition check below).
          ...(canManageAi ? [{ title: ts.menu.ai, href: '/settings/ai', icon: Sparkles }] : []),
          // The EU edition only (ADR OPS-026; hidden elsewhere by the edition check below).
          { title: ts.menu.outsideEu, href: '/settings/outside-eu', icon: Globe },
          { title: ts.menu.plans, href: '/settings/plans', icon: CreditCard },
          { title: ts.menu.billing, href: '/settings/billing', icon: Receipt },
          { title: ts.menu.businessSettings, href: '/settings/business', icon: Building, isActive: pathname === '/settings/business' || pathname === '/settings/general' },
          // WeldBooks entities and WeldHR payroll employers.
          ...(hasEntityApps
            ? [{ title: ts.menu.entities, href: '/settings/entities', icon: Landmark, isActive: (pathname ?? '').startsWith('/settings/entities') }]
            : []),
          { title: ts.menu.legalEntities, href: '/settings/legal-entities', icon: Scale, isActive: (pathname ?? '').startsWith('/settings/legal-entities') },
          { title: ts.menu.apiKeys, href: '/settings/api-keys', icon: Key },
          { title: ts.menu.webhooks, href: '/settings/webhooks', icon: Webhook },
          { title: ts.menu.customFields, href: '/settings/custom-fields', icon: SlidersHorizontal },
          { title: ts.menu.objectTemplates, href: '/settings/object-templates', icon: LayoutTemplate },
          { title: ts.menu.integrations, href: '/settings/integrations', icon: Plug },
          { title: ts.menu.phoneNumbers, href: '/settings/apps/phone-numbers', icon: Phone },
          { title: ts.menu.activityLog, href: '/settings/activity', icon: History },
        ],
      },
      {
        group: ts.menu.apps,
        items: appsItems,
      },
    ];
    // Edition flags (4.F3): only pages this deployment serves (no billing,
    // SSO, integrations, … where the backend lacks them).
    return groups.map((group) => ({ ...group, items: group.items.filter((item) => isRouteOffered(item.href)) }));
  }, [enabled, ts, t.helpdesk, t.deskBi, pathname, installedAppCodes, hasEntityApps, canManageAi]);

  const sidebarProps = React.useMemo(
    () => ({ appName: ts.title, showBackButton: true, onBack: handleBack }),
    [ts.title, handleBack],
  );

  return { menuGroups, sidebarProps };
}
