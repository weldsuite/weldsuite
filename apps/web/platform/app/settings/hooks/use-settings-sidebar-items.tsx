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
} from 'lucide-react';
import { isDesktop } from '@/lib/desktop';
import { getAppLogo, getAppLucideIcon } from '@/lib/apps/app-registry';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { useInstalledApps } from '@/hooks/use-installed-apps';
import { useI18n } from '@/lib/i18n/provider';
import { isRouteOffered } from '@/lib/edition-routes';

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

// Built once so the icon components keep their identity across renders.
const APP_SETTINGS_ITEMS = [
  { appCode: 'parcel', title: 'Parcel', href: '/settings/apps/parcel' },
  { appCode: 'weldcalendar', title: 'WeldCalendar', href: '/settings/apps/weldcalendar' },
  { appCode: 'weldcrm', title: 'WeldCRM', href: '/settings/apps/weldcrm' },
  { appCode: 'welddesk', title: 'WeldDesk', href: '/settings/apps/welddesk' },
  { appCode: 'weldflow', title: 'WeldFlow', href: '/settings/apps/weldflow' },
  { appCode: 'weldmail', title: 'WeldMail', href: '/settings/apps/weldmail' },
  { appCode: 'weldhr', title: 'WeldHR', href: '/settings/apps/weldhr' },
].map(({ appCode, title, href }) => ({ appCode, title, href, icon: makeAppLogoIcon(appCode, title) }));

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

  const installedAppCodes = React.useMemo(
    () => new Set((apps ?? []).filter((app) => app.status === 'active').map((app) => app.appCode)),
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
        .filter((item) => installedAppCodes.has(item.appCode))
        .map(({ appCode, title, href, icon }) => ({
          title: appCode === 'parcel' ? ts.menu.parcel : title,
          href,
          icon,
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
          { title: ts.menu.plans, href: '/settings/plans', icon: CreditCard },
          { title: ts.menu.billing, href: '/settings/billing', icon: Receipt },
          { title: ts.menu.businessSettings, href: '/settings/business', icon: Building, isActive: pathname === '/settings/business' || pathname === '/settings/general' },
          // WeldBooks entities and WeldHR payroll employers.
          ...(hasEntityApps
            ? [{ title: ts.menu.entities, href: '/settings/entities', icon: Landmark, isActive: (pathname ?? '').startsWith('/settings/entities') }]
            : []),
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
  }, [enabled, ts, pathname, installedAppCodes, hasEntityApps]);

  const sidebarProps = React.useMemo(
    () => ({ appName: ts.title, showBackButton: true, onBack: handleBack }),
    [ts.title, handleBack],
  );

  return { menuGroups, sidebarProps };
}
