
import * as React from 'react';
import { useState } from 'react';
import { usePathname, useRouter } from '@/lib/router';
import {
  CreditCard,
  SunMoon,
  Users,
  User,
  Building,
  ChevronLeft,
  Shield,
  ShieldCheck,
  Key,
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
import { AppSidebarLayout, type MenuGroupProps } from '@/components/app-sidebar-layout';
import { SidebarProvider } from '@weldsuite/ui/components/sidebar';
import { useUser, useOrganization, useOrganizationList } from '@clerk/clerk-react';
import { useWorkspace } from '@/contexts/workspace-context';
import { CreateWorkspaceDialog } from '@/components/workspace/create-workspace-dialog';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { useI18n } from '@/lib/i18n/provider';
import { buildBreadcrumbSegments } from './breadcrumbs';

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

const FULL_WIDTH_CLASS = 'h-full';
const PAGE_PADDING_CLASS = 'px-4 md:px-6 pt-4 md:pt-[72px] pb-8';

// Pick the content wrapper classes for the current settings page.
function getContentWrapperClassName(pathname: string): string {
  // Member detail, integrations listing + detail, new number page: full width
  if (
    /^\/settings\/team\/[^/]+$/.test(pathname) ||
    pathname === '/settings/integrations' ||
    /^\/settings\/integrations\/[^/]+$/.test(pathname) ||
    pathname === '/settings/apps/phone-numbers/new-number'
  ) {
    return FULL_WIDTH_CLASS;
  }
  // Plans page - allow internal width control
  if (pathname === '/settings/plans') return PAGE_PADDING_CLASS;
  // Activity log - slightly wider to fit the table without scroll
  if (pathname === '/settings/activity') return `${PAGE_PADDING_CLASS} max-w-6xl mx-auto`;
  // Regular settings pages - constrained width
  return `${PAGE_PADDING_CLASS} max-w-4xl mx-auto`;
}

interface SettingsLayoutClientProps {
  children: React.ReactNode;
  installedAppCodes: string[];
}

export function SettingsLayoutClient({ children, installedAppCodes }: Readonly<SettingsLayoutClientProps>) {
  const { t } = useI18n();
  const ts = t.settings;
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useUser();
  const { organization } = useOrganization();
  const { userMemberships } = useOrganizationList({ userMemberships: true });
  const { switchWorkspace } = useWorkspace();
  const [showCreateWorkspaceDialog, setShowCreateWorkspaceDialog] = useState(false);

  const userInfo = user
    ? {
        name: user.fullName || user.firstName || '',
        email: user.emailAddresses[0]?.emailAddress || '',
        avatar: user.imageUrl,
      }
    : undefined;

  const currentWorkspace = organization
    ? { id: organization.id, name: organization.name }
    : null;

  const workspaces =
    userMemberships?.data?.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
    })) || [];

  const handleBack = () => {
    const url = sessionStorage.getItem('settings-return-url') || '/';
    sessionStorage.removeItem('settings-return-url');
    router.push(url);
  };

  const isInstalled = (appCode: string) => installedAppCodes.includes(appCode);

  const segments = buildBreadcrumbSegments(pathname, ts.title, ts.menu);

  // Build Apps menu items based on installed apps. Use the actual app logo
  // image (with Lucide fallback) instead of generic settings icons.
  // WeldSuite itself is always shown — it's the platform, not an installable app.
  const weldsuiteAppItem = {
    title: 'WeldSuite',
    href: '/settings/apps/weldsuite',
    icon: makeAppLogoIcon('weldsuite', 'WeldSuite'),
  };
  const appsItems = [
    weldsuiteAppItem,
    ...[
      { appCode: 'parcel', title: 'Parcel', href: '/settings/apps/parcel' },
      { appCode: 'weldcrm', title: 'WeldCRM', href: '/settings/apps/weldcrm' },
      { appCode: 'welddesk', title: 'WeldDesk', href: '/settings/apps/welddesk' },
      { appCode: 'weldmail', title: 'WeldMail', href: '/settings/apps/weldmail' },
    ]
      .filter(item => isInstalled(item.appCode))
      .map(({ appCode, title, href }) => ({
        title,
        href,
        icon: makeAppLogoIcon(appCode, title),
      })),
  ];

  const menuItems: MenuGroupProps[] = [
    {
      group: ts.general,
      items: [
        { title: ts.menu.profile, href: '/settings', icon: User, isActive: pathname === '/settings' },
        { title: ts.menu.appearance, href: '/settings/appearance', icon: SunMoon },
        { title: ts.menu.notifications, href: '/settings/notifications', icon: Bell },
        { title: ts.menu.shortcuts, href: '/settings/shortcuts', icon: Keyboard },
        { title: ts.menu.security, href: '/settings/security', icon: Shield },
        // Only visible inside the Electron desktop shell.
        ...(isDesktop() ? [{ title: 'Desktop app', href: '/settings/desktop', icon: Monitor }] : []),
      ],
    },
    {
      group: ts.menu.workspace,
      items: [
        { title: ts.menu.teamMembers, href: '/settings/team', icon: Users },
        { title: 'Roles & Permissions', href: '/settings/roles', icon: ShieldCheck },
        { title: ts.menu.plans, href: '/settings/plans', icon: CreditCard },
        { title: ts.menu.billing, href: '/settings/billing', icon: Receipt },
        { title: ts.menu.businessSettings, href: '/settings/business', icon: Building, isActive: pathname === '/settings/business' || pathname === '/settings/general' },
        { title: ts.menu.apiKeys, href: '/settings/api-keys', icon: Key },
        { title: ts.menu.webhooks, href: '/settings/webhooks', icon: Webhook },
        { title: ts.menu.customFields, href: '/settings/custom-fields', icon: SlidersHorizontal },
        { title: ts.menu.objectTemplates, href: '/settings/object-templates', icon: LayoutTemplate },
        { title: ts.menu.integrations, href: '/settings/integrations', icon: Plug },
        { title: ts.menu.phoneNumbers, href: '/settings/apps/phone-numbers', icon: Phone },
        { title: ts.menu.activityLog, href: '/settings/activity', icon: History },
      ],
    },
    // Only show Apps group if there are installed app items
    ...(appsItems.length > 0
      ? [{
          group: ts.menu.apps,
          items: appsItems,
        }]
      : []),
  ];

  return (
    <SidebarProvider>
      <div className="flex h-full w-full">
        <AppSidebarLayout
          appName={ts.title}
          appIcon={ChevronLeft}
          menuItems={menuItems}
          showBackButton
          onBack={handleBack}
          user={userInfo}
          currentWorkspace={currentWorkspace}
          workspaces={workspaces}
          onWorkspaceSwitch={async (id) => switchWorkspace(id)}
          onWorkspaceCreate={() => setShowCreateWorkspaceDialog(true)}
        />
        <CreateWorkspaceDialog open={showCreateWorkspaceDialog} onOpenChange={setShowCreateWorkspaceDialog} />
        <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden md:border-l md:border-border">
          <BreadcrumbHeader
            segments={segments}
            showBackButton={false}
            moduleKey="settings"
          />
          <ModuleContent className="overflow-y-auto">
            <div className={getContentWrapperClassName(pathname)}>{children}</div>
          </ModuleContent>
        </div>
      </div>
    </SidebarProvider>
  );
}
