
import * as React from 'react';
import { usePathname, Link } from '@/lib/router';
import {
  Inbox,
  Mail,
  MessageSquare,
  MessageCircle,
  Ticket,
  ChevronDown,
  ChevronUp,
  Archive,
  Slack,
} from 'lucide-react';
import { AppSidebarLayout, type MenuGroupProps, type UserInfo, type Workspace } from '@/components/app-sidebar-layout';
import { CreateWorkspaceDialog } from '@/components/workspace/create-workspace-dialog';
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@weldsuite/ui/components/sidebar';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWorkspace } from '@/contexts/workspace-context';
import { usePermissions } from '@weldsuite/permissions/react';
import { MODULE_CONFIGS, getModuleKey } from './module-sidebar-configs';
import { useCrmSidebarItems } from '@/app/weldcrm/hooks/use-crm-sidebar-items';
import { useWelddataSidebarItems } from '@/app/welddata/hooks/use-welddata-sidebar-items';
import { useMailSidebarItems } from '@/app/weldmail/hooks/use-mail-sidebar-items';
import { useProjectsSidebarItems } from '@/app/weldflow/hooks/use-projects-sidebar-items';
import { useHelpdeskSidebarItems } from '@/app/welddesk/hooks/use-helpdesk-sidebar-items';
import { useWeldchatSidebarItems } from '@/app/weldchat/hooks/use-weldchat-sidebar-items';
import { useCalendarSidebarItems } from '@/app/weldcalendar/hooks/use-calendar-sidebar-items';
import { useHomeSidebarItems } from '@/app/use-home-sidebar-items';
import { useAgentsSidebarItems } from '@/app/agents/hooks/use-agents-sidebar-items';
import { useHelpdeskFolderCounts, type HelpdeskFolderCounts } from '@/hooks/queries/use-helpdesk-queries';

interface UnifiedModuleSidebarProps {
  user?: UserInfo;
  currentWorkspace?: Workspace | null;
  workspaces?: Workspace[];
}

// Map inbox hrefs to folder count keys
const inboxBadgeKeyMap: Record<string, keyof HelpdeskFolderCounts> = {
  '/welddesk/inbox/all': 'all',
  '/welddesk/inbox/chat': 'chat',
};

// Build the helpdesk inbox group with More/Less toggle
function buildHelpdeskInboxGroup(
  showMore: boolean,
  setShowMore: (v: boolean) => void,
  pathname: string,
  st: (path: string, params?: Record<string, unknown>) => string,
  folderCounts?: HelpdeskFolderCounts
): MenuGroupProps {
  const importantInboxItems = [
    { title: st('sweep.shared.allMessages'), href: '/welddesk/inbox/all', icon: Inbox },
    { title: st('sweep.shared.tickets'), href: '/welddesk/tickets', icon: Ticket },
    { title: st('sweep.shared.email'), href: '/welddesk/inbox/email', icon: Mail },
    { title: st('sweep.shared.liveChat'), href: '/welddesk/inbox/chat', icon: MessageSquare },
    { title: st('sweep.shared.archived'), href: '/welddesk/inbox/archived', icon: Archive },
  ];

  const lessInboxItems = [
    { title: 'Discord', href: '/welddesk/inbox/discord', icon: MessageCircle },
    { title: 'Slack', href: '/welddesk/inbox/slack', icon: Slack },
  ];

  const allInboxItems = [...importantInboxItems, ...lessInboxItems];

  const renderItem = (item: typeof importantInboxItems[0]) => {
    const Icon = item.icon;
    const isActive = pathname === item.href;
    const badgeKey = inboxBadgeKeyMap[item.href];
    const badgeCount = badgeKey && folderCounts ? folderCounts[badgeKey] : 0;
    return (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton asChild isActive={isActive}>
          <Link href={item.href}>
            <Icon className="h-4 w-4" />
            <span>{item.title}</span>
          </Link>
        </SidebarMenuButton>
        {badgeCount > 0 && (
          <SidebarMenuBadge>{badgeCount}</SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    );
  };

  return {
    group: st('sweep.shared.inbox'),
    customContent: (
      <SidebarMenu>
        {importantInboxItems.map(renderItem)}
        {showMore && lessInboxItems.map(renderItem)}
        <SidebarMenuItem>
          <SidebarMenuButton onClick={() => setShowMore(!showMore)} className="text-sidebar-foreground">
            {showMore ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
            <span>{showMore ? st('sweep.shared.less') : st('sweep.shared.more')}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    ),
    items: allInboxItems,
  };
}

export function UnifiedModuleSidebar({ user, currentWorkspace, workspaces = [] }: UnifiedModuleSidebarProps) {
  const pathname = usePathname();
  const { t } = useI18n();
  const st = useTranslations();
  const { switchWorkspace } = useWorkspace();
  const { isOwner, can } = usePermissions();
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const [helpdeskShowMore, setHelpdeskShowMore] = React.useState(false);

  const moduleKey = getModuleKey(pathname);

  // ALL hooks called unconditionally (React rules)
  const crmItems = useCrmSidebarItems(moduleKey === 'weldcrm');
  const welddataItems = useWelddataSidebarItems(moduleKey === 'welddata');
  const mailItems = useMailSidebarItems(moduleKey === 'weldmail');
  const projectsItems = useProjectsSidebarItems(moduleKey === 'weldflow');
  const helpdeskItems = useHelpdeskSidebarItems(moduleKey === 'welddesk');
  const weldchatItems = useWeldchatSidebarItems(moduleKey === 'weldchat');
  const calendarItems = useCalendarSidebarItems(moduleKey === 'weldcalendar');
  const homeItems = useHomeSidebarItems(moduleKey === 'home');
  const agentsItems = useAgentsSidebarItems(moduleKey === 'agents');
  const { data: folderCounts } = useHelpdeskFolderCounts();

  const config = moduleKey ? MODULE_CONFIGS[moduleKey] : null;
  if (!config) return null;

  // Build final menu items
  const staticItems = config.getMenuItems(t);
  let menuItems: MenuGroupProps[];
  let extraProps: Record<string, any> = {};

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
      menuItems = [
        ...staticItems,
        buildHelpdeskInboxGroup(helpdeskShowMore, setHelpdeskShowMore, pathname, st, folderCounts),
        ...helpdeskItems.menuGroups,
      ];
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
