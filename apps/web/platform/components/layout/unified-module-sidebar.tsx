
import * as React from 'react';
import { usePathname } from '@/lib/router';
import { AppSidebarLayout, type MenuGroupProps, type UserInfo, type Workspace } from '@/components/app-sidebar-layout';
import { CreateWorkspaceDialog } from '@/components/workspace/create-workspace-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useWorkspace } from '@/contexts/workspace-context';
import { usePermissions } from '@weldsuite/permissions/react';
import { menuPermissionAllows } from './menu-permission';
import { MODULE_CONFIGS, getModuleKey } from './module-sidebar-configs';
import { buildUserAppSidebarConfig, type UserAppNavItem } from './user-app-sidebar';
import { buildCustomObjectSidebarConfig } from './custom-object-sidebar';
import type { InstalledApp } from '@/lib/api/apps';
import { useInstalledUserApps } from '@/hooks/queries/use-user-apps-queries';
import { useCrmSidebarItems } from '@/app/weldcrm/hooks/use-crm-sidebar-items';
import { useWelddataSidebarItems } from '@/app/welddata/hooks/use-welddata-sidebar-items';
import { useMailSidebarItems } from '@/app/weldmail/hooks/use-mail-sidebar-items';
import { useProjectsSidebarItems } from '@/app/weldflow/hooks/use-projects-sidebar-items';
import { useWeldchatSidebarItems } from '@/app/weldchat/hooks/use-weldchat-sidebar-items';
import { useCalendarSidebarItems } from '@/app/weldcalendar/hooks/use-calendar-sidebar-items';
import { useHomeSidebarItems } from '@/app/use-home-sidebar-items';
import { useAgentsSidebarItems } from '@/app/agents/hooks/use-agents-sidebar-items';
import { useWeldconnectSidebarItems } from '@/app/weldconnect/hooks/use-weldconnect-sidebar-items';
import { useWeldknowSidebarItems } from '@/app/weldknow/hooks/use-weldknow-sidebar-items';
import { useWeldbooksSidebarItems } from '@/app/weldbooks/hooks/use-weldbooks-sidebar-items';
import { useWeldhrSidebarItems } from '@/app/weldhr/hooks/use-weldhr-sidebar-items';
import { useSettingsSidebarItems } from '@/app/settings/hooks/use-settings-sidebar-items';
import { resolveAppCode } from '@/lib/apps/app-registry';
import { useBetaAppCodes } from '@/hooks/queries/use-settings-queries';

interface UnifiedModuleSidebarProps {
  user?: UserInfo;
  currentWorkspace?: Workspace | null;
  workspaces?: Workspace[];
  /** The shell's installed-app list; custom objects are read from it. */
  installedApps?: InstalledApp[];
}

function readNavigation(manifest: Record<string, unknown> | null | undefined): UserAppNavItem[] | null {
  const raw = manifest?.navigation;
  if (!Array.isArray(raw)) return null;
  const items: UserAppNavItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.label !== 'string' || typeof row.path !== 'string') {
      continue;
    }
    items.push({
      id: row.id,
      label: row.label,
      path: row.path,
      icon: typeof row.icon === 'string' ? row.icon : undefined,
      permission: typeof row.permission === 'string' ? row.permission : undefined,
      group: typeof row.group === 'string' ? row.group : undefined,
    });
  }
  return items.length > 0 ? items : null;
}

/**
 * The sidebar of the module the current route is in: its static menu plus the
 * module's own dynamic items, then filtered by the member's permissions.
 */
export function UnifiedModuleSidebar({ user, currentWorkspace, workspaces = [], installedApps }: Readonly<UnifiedModuleSidebarProps>) {
  const pathname = usePathname();
  const { t } = useI18n();
  const { switchWorkspace } = useWorkspace();
  const { isOwner, can } = usePermissions();
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);

  const moduleKey = getModuleKey(pathname);
  const { data: betaAppCodes } = useBetaAppCodes();
  const userAppCode = moduleKey?.startsWith('user-app:') ? moduleKey.slice('user-app:'.length) : null;
  const { data: installedUserApps } = useInstalledUserApps(!!userAppCode);
  const installedUserApp = userAppCode
    ? installedUserApps?.find((app) => app.appCode === userAppCode)
    : undefined;

  const userAppConfig = React.useMemo(() => {
    if (!userAppCode || !installedUserApp) return null;
    return buildUserAppSidebarConfig({
      appCode: userAppCode,
      name: installedUserApp.name,
      icon: installedUserApp.icon,
      navigation: readNavigation(installedUserApp.manifest),
      defaultGroupLabel: t.navigation.moduleSidebar.groups.general,
    });
  }, [userAppCode, installedUserApp, t.navigation.moduleSidebar.groups.general]);

  // Custom objects come from the shell's installed-app list (active objects the
  // member may read), which is already loaded for the rail, so no extra fetch.
  const objectSlug = moduleKey?.startsWith('object:') ? moduleKey.slice('object:'.length) : null;
  const objectApp = objectSlug
    ? installedApps?.find((app) => app.appType === 'object' && app.appCode === objectSlug)
    : undefined;

  const objectConfig = React.useMemo(() => {
    if (!objectApp) return null;
    return buildCustomObjectSidebarConfig({
      id: objectApp.id,
      slug: objectApp.appCode,
      labelPlural: objectApp.name,
      icon: objectApp.icon,
    });
  }, [objectApp]);

  // ALL hooks called unconditionally (React rules)
  const crmItems = useCrmSidebarItems(moduleKey === 'weldcrm');
  const welddataItems = useWelddataSidebarItems(moduleKey === 'welddata');
  const mailItems = useMailSidebarItems(moduleKey === 'weldmail');
  const projectsItems = useProjectsSidebarItems(moduleKey === 'weldflow');
  const weldchatItems = useWeldchatSidebarItems(moduleKey === 'weldchat');
  const calendarItems = useCalendarSidebarItems(moduleKey === 'weldcalendar');
  const homeItems = useHomeSidebarItems(moduleKey === 'home');
  const agentsItems = useAgentsSidebarItems(moduleKey === 'agents');
  const weldconnectItems = useWeldconnectSidebarItems(moduleKey === 'weldconnect');
  const weldknowItems = useWeldknowSidebarItems(moduleKey === 'weldknow');
  const weldbooksItems = useWeldbooksSidebarItems(moduleKey === 'weldbooks');
  const weldhrItems = useWeldhrSidebarItems(moduleKey === 'weldhr');
  const settingsItems = useSettingsSidebarItems(moduleKey === 'settings');

  const config =
    userAppConfig ?? objectConfig ?? (moduleKey && !userAppCode && !objectSlug ? MODULE_CONFIGS[moduleKey] : null);
  if (!config) return null;

  // Build final menu items
  const staticItems = config.getMenuItems(t);
  let menuItems: MenuGroupProps[];
  let extraProps: Record<string, unknown> = {};

  switch (moduleKey) {
    case 'weldcrm':
      menuItems = [...staticItems, ...crmItems.menuGroups];
      break;
    case 'welddata':
      menuItems = [...staticItems, ...welddataItems.menuGroups];
      break;
    case 'weldmail':
      menuItems = mailItems.menuGroups;
      extraProps = mailItems.emailAccountProps;
      break;
    case 'weldflow':
      menuItems = projectsItems.menuGroups;
      break;
    case 'welddesk':
      menuItems = staticItems;
      break;
    case 'weldchat':
      menuItems = weldchatItems.menuGroups;
      break;
    case 'weldcalendar':
      menuItems = [...staticItems, ...calendarItems.menuGroups];
      break;
    case 'home':
      menuItems = homeItems.menuGroups;
      break;
    case 'agents':
      menuItems = agentsItems.menuGroups;
      break;
    case 'weldconnect':
      menuItems = weldconnectItems.menuGroups;
      break;
    case 'weldknow':
      menuItems = weldknowItems.menuGroups;
      break;
    case 'weldbooks':
      // Tax item gated + labelled by the entity's jurisdiction.
      menuItems = weldbooksItems.adjust(staticItems);
      break;
    case 'weldhr':
      // My HR on top for whoever has it, collapsible next to the team view;
      // payroll items follow the weldhr-payroll flag.
      menuItems = weldhrItems.adjust(staticItems);
      break;
    case 'settings':
      // Translated title + back button replace the module brand.
      menuItems = settingsItems.menuGroups;
      extraProps = settingsItems.sidebarProps;
      break;
    default:
      menuItems = staticItems;
  }

  // Permission filtering: remove items the user lacks access to, then drop empty groups.
  // Owner always passes. Items without a `permission` field always show.
  // Groups with `customContent` are passed through as-is (they manage their own rendering).
  const visibleMenuItems: MenuGroupProps[] = menuItems
    .map((group) => {
      if (group.customContent) return group;
      const visibleItems = group.items.filter(
        (item) => menuPermissionAllows(item.permission, (permission) => isOwner || can(permission))
      );
      return { ...group, items: visibleItems };
    })
    .filter(
      (group) =>
        group.customContent !== undefined ||
        group.items.length > 0 ||
        group.keepWhenEmpty ||
        // A collapsed group's `items` is the peek subset (often empty), but
        // the user has explicitly asked to keep its header visible — don't
        // drop it as if it had nothing in it.
        group.collapsed,
    );

  // Workspace switching (shared across all modules)
  const handleWorkspaceSwitch = (id: string) => Promise.resolve(switchWorkspace(id));
  const handleWorkspaceCreate = () => setShowCreateDialog(true);

  return (
    <>
      <AppSidebarLayout
        appName={config.appName}
        appIcon={config.appIcon}
        appLogo={config.appLogo}
        appBeta={moduleKey ? (betaAppCodes?.has(resolveAppCode(moduleKey)) ?? false) : false}
        menuItems={visibleMenuItems}
        user={user}
        currentWorkspace={currentWorkspace}
        workspaces={workspaces}
        onWorkspaceSwitch={handleWorkspaceSwitch}
        onWorkspaceCreate={handleWorkspaceCreate}
        hideScrollbar={moduleKey !== 'weldchat'}
        {...extraProps}
      />
      {/* Module-specific dialogs */}
      {moduleKey === 'weldcrm' && crmItems.dialogs}
      {moduleKey === 'welddata' && welddataItems.dialogs}
      {moduleKey === 'weldmail' && mailItems.dialogs}
      {moduleKey === 'weldflow' && projectsItems.dialogs}
      {moduleKey === 'weldchat' && weldchatItems.dialogs}
      {moduleKey === 'weldcalendar' && calendarItems.dialogs}
      {moduleKey === 'home' && homeItems.dialogs}
      {moduleKey === 'weldknow' && weldknowItems.dialogs}
      <CreateWorkspaceDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} />
    </>
  );
}
