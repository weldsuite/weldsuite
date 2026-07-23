
import React, { useMemo } from 'react';
import { Users } from 'lucide-react';
import { usePathname, Link } from '@/lib/router';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@weldsuite/ui/components/sidebar';
import { useDepartments, useDepartmentInboxCounts } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';

export function useHelpdeskSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
} {
  const { t } = useI18n();
  const pathname = usePathname();
  const { data: departmentsResult } = useDepartments(
    isActive ? { isActive: true, pageSize: 50 } : undefined
  );
  const { data: countsResult } = useDepartmentInboxCounts();

  const menuGroups = useMemo<MenuGroupProps[]>(() => {
    if (!isActive) return [];

    const departments = departmentsResult?.data || [];
    const counts = countsResult?.data || [];

    if (departments.length === 0) return [];

    const countMap = new Map(
      counts.map((c: { departmentId: string; activeCount: number }) => [c.departmentId, c.activeCount])
    );

    const items = departments.map((dept: any) => ({
      title: dept.name,
      href: `/welddesk/inbox/team/${dept.id}`,
      icon: Users,
    }));

    return [
      {
        group: t.helpdesk.sidebar.teamsGroup,
        items,
        customContent: React.createElement(
          SidebarMenu,
          null,
          departments.map((dept: any) => {
            const href = `/welddesk/inbox/team/${dept.id}`;
            const isItemActive = pathname.startsWith(href);
            const count = countMap.get(dept.id);
            return React.createElement(
              SidebarMenuItem,
              { key: dept.id },
              React.createElement(
                SidebarMenuButton,
                { asChild: true, isActive: isItemActive },
                React.createElement(
                  Link,
                  { href },
                  React.createElement(Users, { className: 'h-4 w-4' }),
                  React.createElement('span', null, dept.name)
                )
              ),
              count
                ? React.createElement(SidebarMenuBadge, null, count)
                : null
            );
          })
        ),
      },
    ];
  }, [isActive, departmentsResult, countsResult, pathname, t]);

  return { menuGroups };
}
