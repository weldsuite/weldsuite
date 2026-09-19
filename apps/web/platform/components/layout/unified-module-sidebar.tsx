
import * as React from 'react';
import { usePathname } from '@/lib/router';
import { AppSidebarLayout, type MenuGroupProps, type UserInfo, type Workspace } from '@/components/app-sidebar-layout';
import { CreateWorkspaceDialog } from '@/components/workspace/create-workspace-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useWorkspace } from '@/contexts/workspace-context';
import { usePermissions } from '@weldsuite/permissions/react';
import { MODULE_CONFIGS, getModuleKey } from './module-sidebar-configs';
import { buildUserAppSidebarConfig, type UserAppNavItem } from './user-app-sidebar';
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

interface UnifiedModuleSidebarProps {
  user?: UserInfo;
  currentWorkspace?: Workspace | null;
  workspaces?: Workspace[];
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

export function UnifiedModuleSidebar({ user, currentWorkspace, workspaces = [] }: UnifiedModuleSidebarProps) {
  const pathname = usePathname();
  const { t } = useI18n();
  const { switchWorkspace } = useWorkspace();
  const { isOwner, can } = usePermissions();
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);

  const moduleKey = getModuleKey(pathname);
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

  const config = userAppConfig ?? (moduleKey && !userAppCode ? MODULE_CONFIGS[moduleKey] : null);
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
        (item) => !item.permission || isOwner || can(item.permission)
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
  const handleWorkspaceSwitch = async (id: string) => switchWorkspace(id);
  const handleWorkspaceCreate = () => setShowCreateDialog(true);

  return (
    <>
      <AppSidebarLayout
        appName={config.appName}
        appIcon={config.appIcon}
        appLogo={config.appLogo}
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
      <CreateWorkspaceDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} />
    </>
  );
}
