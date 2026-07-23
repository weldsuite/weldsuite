"use client"

import * as React from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./sidebar"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { LucideIcon, Plus, MoreVertical } from "lucide-react"
import { cn } from "../lib/utils"
import { SidebarUserMenu, type SidebarUserMenuProps } from "./sidebar-user-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "./dropdown-menu"
import { Button } from "./button"

export { SidebarUserMenu, type SidebarUserMenuProps }

export interface ItemAction {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
}

export interface MenuItemProps {
  title: string;
  href: string;
  icon: LucideIcon;
  actions?: ItemAction[];
}

export interface MenuGroupProps {
  group: string;
  items: MenuItemProps[];
  customContent?: React.ReactNode;
  onAdd?: () => void;
}

export interface AppSidebarLayoutProps extends React.ComponentProps<typeof Sidebar> {
  appName: string;
  appIcon: LucideIcon;
  menuItems: MenuGroupProps[];
  workspaceSwitcher?: React.ReactNode;
  footer?: React.ReactNode;
  userMenu?: React.ReactNode;
}

export function AppSidebarLayout({
  appName,
  appIcon: AppIcon,
  menuItems,
  workspaceSwitcher,
  footer,
  userMenu,
  ...props
}: AppSidebarLayoutProps) {
  const pathname = usePathname()
  const { state } = useSidebar()

  return (
    <Sidebar collapsible="icon" className="relative" {...props}>
      <SidebarHeader>
        <div className="flex flex-col gap-2 px-2 py-2">
          <div className={cn(
            "flex items-center gap-2 px-2",
            state === "collapsed" && "justify-center px-0"
          )}>
            <AppIcon className="h-6 w-6 shrink-0" />
            {state === "expanded" && (
              <span className="text-lg font-semibold">{appName}</span>
            )}
          </div>
          {workspaceSwitcher && state === "expanded" && (
            <div className="px-2">
              {workspaceSwitcher}
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        {menuItems.map((group) => (
          <SidebarGroup key={group.group}>
            {group.group && (
              <>
                <SidebarGroupLabel>{group.group}</SidebarGroupLabel>
                {group.onAdd && (
                  <SidebarGroupAction onClick={group.onAdd}>
                    <Plus />
                    <span className="sr-only">Add {group.group}</span>
                  </SidebarGroupAction>
                )}
              </>
            )}
            <SidebarGroupContent>
              {group.customContent ? (
                group.customContent
              ) : (
                <SidebarMenu>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    // Check if current path is active
                    // Exact match: pathname exactly equals href
                    const isExactMatch = pathname === item.href;

                    // For nested child routes (e.g., /analytics when on /analytics/performance)
                    // Only match if pathname has MORE segments than item.href
                    // This prevents /parcel from matching /parcel/parcels
                    const itemSegments = item.href.split('/').filter(Boolean).length;
                    const pathSegments = pathname?.split('/').filter(Boolean).length || 0;
                    const isNestedRoute = item.href !== '/' &&
                      pathname?.startsWith(item.href + '/') &&
                      pathSegments > itemSegments;

                    const isActive = isExactMatch || isNestedRoute;

                    return (
                      <SidebarMenuItem key={item.href}>
                        <div
                          className={cn(
                            "group/item flex items-center justify-between rounded-md transition-colors hover:bg-accent"
                          )}
                        >
                          <SidebarMenuButton asChild isActive={isActive} className="flex-1 hover:bg-transparent">
                            <Link href={item.href}>
                              <Icon className="h-4 w-4" />
                              <span>{item.title}</span>
                            </Link>
                          </SidebarMenuButton>
                          {item.actions && item.actions.length > 0 && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={cn(
                                    "h-6 w-6 mr-1 transition-opacity opacity-0 group-hover/item:opacity-100 hover:bg-muted-foreground/20 rounded-sm"
                                  )}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <MoreVertical className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {item.actions.map((action, idx) => {
                                  const ActionIcon = action.icon;
                                  return (
                                    <React.Fragment key={idx}>
                                      <DropdownMenuItem onClick={action.onClick}>
                                        {ActionIcon && <ActionIcon className="mr-2 h-4 w-4" />}
                                        {action.label}
                                      </DropdownMenuItem>
                                      {idx < item.actions!.length - 1 && action.label === 'Rename' && (
                                        <DropdownMenuSeparator />
                                      )}
                                    </React.Fragment>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {(footer || userMenu) && (
        <SidebarFooter>
          {userMenu}
          {footer}
        </SidebarFooter>
      )}
      <SidebarRail />
    </Sidebar>
  )
}