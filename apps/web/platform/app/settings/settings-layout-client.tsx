
import * as React from 'react';
import { useState } from 'react';
import { usePathname, useRouter } from '@/lib/router';
import {
  CreditCard,
  SunMoon,
  Users,
  User,
  Building,
  ShoppingCart,
  Package,
  Headset,
  Mail,
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
import { BreadcrumbHeader, type BreadcrumbSegment, type SearchResult } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { useI18n } from '@/lib/i18n/provider';

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

interface SettingsLayoutClientProps {
  children: React.ReactNode;
  installedAppCodes: string[];
}

// Map settings sidebar items to the app code that must be installed
const APP_SETTINGS_MAP: Record<string, { appCode: string; title: string; href: string; icon: any }> = {
  parcel: { appCode: 'parcel', title: 'Parcel', href: '/settings/apps/parcel', icon: Package },
  weldcrm: { appCode: 'weldcrm', title: 'WeldCRM', href: '/settings/apps/weldcrm', icon: Users },
  welddesk: { appCode: 'welddesk', title: 'WeldDesk', href: '/settings/apps/welddesk', icon: Headset },
  weldmail: { appCode: 'weldmail', title: 'WeldMail', href: '/settings/apps/weldmail', icon: Mail },
};

export function SettingsLayoutClient({ children, installedAppCodes }: SettingsLayoutClientProps) {
  const { t } = useI18n();
  const ts = t.settings;
  // t is kept in scope for cross-module references (e.g. t.crm)
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

  // Generate breadcrumb segments based on the current path
  const segments: BreadcrumbSegment[] = [
    { label: ts.title, href: '/settings' },
  ];

  // Parse pathname to create breadcrumbs
  const pathParts = pathname.split('/').filter(Boolean);

  if (pathParts.length > 1) {
    for (let i = 1; i < pathParts.length; i++) {
      const part = pathParts[i];
      const href = '/' + pathParts.slice(0, i + 1).join('/');

      // Capitalize and format the label
      const label = part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');

      // If it's the last part, don't add href
      const isLast = i === pathParts.length - 1;

      if (isLast) {
        segments.push({ label });
      } else {
        segments.push({ label, href });
      }
    }
  } else {
    // /settings index page is the profile editor — show it as a leaf segment.
    segments.push({ label: ts.menu.profile });
  }

  // Search items that are app-specific
  const appSearchItems: Record<string, SearchResult[]> = {
    parcel: [
      { id: 'parcel', title: ts.search.parcelSettings, description: ts.search.configureParcel, href: '/settings/apps/parcel', type: 'setting' },
    ],
    weldcrm: [
      { id: 'weldcrm', title: 'WeldCRM', description: 'Configure CRM settings', href: '/settings/apps/weldcrm', type: 'setting' },
      { id: 'customer-statuses', title: t.crm.settings.customerStatuses.title, description: t.crm.settings.customerStatuses.subtitle, href: '/settings/apps/weldcrm', type: 'setting' },
    ],
    welddesk: [
      { id: 'helpdesk', title: ts.search.helpdeskSettings, description: ts.search.configureHelpdesk, href: '/settings/apps/welddesk', type: 'setting' },
      { id: 'helpdesk-tickets', title: 'Ticket Settings', description: 'Configure ticket types and custom fields', href: '/settings/apps/welddesk?tab=tickets', type: 'setting' },
    ],
    weldmail: [
      { id: 'weldmail', title: 'WeldMail', description: 'Configure mail app', href: '/settings/apps/weldmail', type: 'setting' },
      { id: 'mail-accounts', title: ts.search.mailAccounts, description: ts.search.manageMailAccounts, href: '/settings/apps/weldmail', type: 'setting' },
    ],
  };

  // Search function for settings - only include app-specific items if the app is installed
  const handleSearch = async (query: string): Promise<SearchResult[]> => {
    const allSettings: SearchResult[] = [
      { id: 'profile', title: ts.menu.profile, description: ts.search.profile, href: '/settings', type: 'setting' },
      { id: 'appearance', title: ts.menu.appearance, description: ts.search.appearance, href: '/settings/appearance', type: 'setting' },
      { id: 'notifications', title: ts.menu.notifications, description: ts.search.notifications, href: '/settings/notifications', type: 'setting' },
      { id: 'security', title: ts.menu.security, description: ts.search.security, href: '/settings/security', type: 'setting' },
      { id: 'team', title: ts.menu.teamMembers, description: ts.search.teamMembers, href: '/settings/team', type: 'setting' },
      { id: 'plans', title: ts.menu.plans, description: ts.search.plans, href: '/settings/plans', type: 'setting' },
      { id: 'billing', title: ts.menu.billing, description: ts.search.billing, href: '/settings/billing', type: 'setting' },
      { id: 'business', title: ts.menu.businessSettings, description: ts.search.businessSettings, href: '/settings/business', type: 'setting' },
      { id: 'api-keys', title: ts.menu.apiKeys, description: ts.search.apiKeys, href: '/settings/api-keys', type: 'setting' },
      { id: 'webhooks', title: ts.menu.webhooks, description: ts.search.webhooks, href: '/settings/webhooks', type: 'setting' },
      { id: 'custom-fields', title: ts.menu.customFields, description: ts.search.customFields, href: '/settings/custom-fields', type: 'setting' },
      { id: 'object-templates', title: ts.menu.objectTemplates, description: ts.search.objectTemplates, href: '/settings/object-templates', type: 'setting' },
      { id: 'integrations', title: ts.menu.integrations, description: ts.search.integrations, href: '/settings/integrations', type: 'setting' },
      { id: 'phone-numbers', title: ts.menu.phoneNumbers, description: ts.search.phoneNumbers, href: '/settings/apps/phone-numbers', type: 'setting' },
      { id: 'activity', title: ts.menu.activityLog, description: ts.search.activityLog, href: '/settings/activity', type: 'setting' },
    ];

    // Add app-specific search items only if the app is installed
    for (const [appCode, items] of Object.entries(appSearchItems)) {
      if (isInstalled(appCode)) {
        allSettings.push(...items);
      }
    }

    const lowerQuery = query.toLowerCase();
    return allSettings.filter(
      setting =>
        setting.title.toLowerCase().includes(lowerQuery) ||
        (setting.description?.toLowerCase().includes(lowerQuery) ?? false)
    );
  };

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
        { title: ts.menu.profile, href: '/settings', icon: User },
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
        { title: ts.menu.businessSettings, href: '/settings/business', icon: Building },
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
        <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
          <BreadcrumbHeader
            segments={segments}
            onSearch={handleSearch}
            searchPlaceholder={ts.searchPlaceholder}
            showBackButton={false}
            moduleKey="settings"
          />
          <ModuleContent className="overflow-y-auto">
            {pathname.match(/^\/settings\/team\/[^/]+$/) ? (
              // Member detail page - full width layout
              <div className="h-full">
                {children}
              </div>
            ) : pathname === '/settings/integrations' || pathname.match(/^\/settings\/integrations\/[^/]+$/) ? (
              // Integrations listing + detail - full width for appstore-like design
              <div className="h-full">
                {children}
              </div>
            ) : pathname === '/settings/apps/phone-numbers/new-number' ? (
              // New number page - full width for HostEntityFormLayout with sidebar
              <div className="h-full">
                {children}
              </div>
            ) : pathname === '/settings/plans' ? (
              // Plans page - allow internal width control
              <div className="px-4 md:px-6 pt-4 md:pt-[72px] pb-8">
                {children}
              </div>
            ) : pathname === '/settings/activity' ? (
              // Activity log - slightly wider to fit the table without scroll
              <div className="px-4 md:px-6 pt-4 md:pt-[72px] pb-8 max-w-6xl mx-auto">
                {children}
              </div>
            ) : (
              // Regular settings pages - constrained width
              <div className="px-4 md:px-6 pt-4 md:pt-[72px] pb-8 max-w-4xl mx-auto">
                {children}
              </div>
            )}
          </ModuleContent>
        </div>
      </div>
    </SidebarProvider>
  );
}
