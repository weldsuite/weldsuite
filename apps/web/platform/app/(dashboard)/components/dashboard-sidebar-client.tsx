
import * as React from 'react';
import {
  Home,
  LayoutDashboard,
  Calculator,
  UserCircle,
  Warehouse,
  Mail,
  Headphones,
  Truck,
  FolderKanban,
  CheckSquare,
  Server,
  MessageCircle,
  CalendarDays,
  HardDrive,
  Share2,
} from 'lucide-react';
import { AppSidebarLayout, type MenuGroupProps, type UserInfo, type Workspace } from '@/components/app-sidebar-layout';
import { CreateWorkspaceDialog } from '@/components/workspace/create-workspace-dialog';
import type { InstalledApp } from '@/lib/api/apps';
import { useWorkspace } from '@/contexts/workspace-context';
import { getTranslations } from '@/lib/i18n';

interface DashboardSidebarClientProps {
  user?: UserInfo;
  currentWorkspace?: Workspace | null;
  workspaces?: Workspace[];
  installedApps: InstalledApp[];
}

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  weldbooks: Calculator,
  weldcrm: UserCircle,
  weldstash: Warehouse,
  wms: Warehouse,
  weldmail: Mail,
  welddesk: Headphones,
  parcel: Truck,
  weldflow: FolderKanban,
  weldconnect: CheckSquare,
  weldhost: Server,
  weldchat: MessageCircle,
  weldcalendar: CalendarDays,
  welddrive: HardDrive,
  social: Share2,
  weldsocial: Share2,
};

export function DashboardSidebarClient({
  user,
  currentWorkspace,
  workspaces = [],
  installedApps
}: DashboardSidebarClientProps) {
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const { switchWorkspace } = useWorkspace();
  const t = getTranslations('navigation');

  // Workspace switching handlers
  const handleWorkspaceSwitch = React.useCallback(async (workspaceId: string) => {
    await switchWorkspace(workspaceId);
  }, [switchWorkspace]);

  const handleWorkspaceCreate = React.useCallback(() => {
    setShowCreateDialog(true);
  }, []);

  // Build Available Apps menu items from installed apps
  const availableAppsItems = installedApps.map((app) => {
    const IconComponent = iconMap[app.appCode] || Server;
    return {
      title: app.name,
      href: `/${app.appCode}`,
      icon: IconComponent,
    };
  });

  const menuItems: MenuGroupProps[] = [
    {
      group: t.dashboardSidebar.groupOverview,
      items: [
        { title: t.dashboardSidebar.itemHome, href: '/', icon: Home },
        { title: t.dashboardSidebar.itemNewChat, href: '/new-chat', icon: LayoutDashboard },
      ],
    },
    ...(availableAppsItems.length > 0 ? [{
      group: t.dashboardSidebar.groupAvailableApps,
      items: availableAppsItems,
    }] : []),
  ];

  return (
    <>
      <AppSidebarLayout
        appName={t.dashboardSidebar.appName}
        appIcon={LayoutDashboard}
        menuItems={menuItems}
        user={user}
        currentWorkspace={currentWorkspace}
        workspaces={workspaces}
        onWorkspaceSwitch={handleWorkspaceSwitch}
        onWorkspaceCreate={handleWorkspaceCreate}
      />
      <CreateWorkspaceDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
      />
    </>
  );
}
