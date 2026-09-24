
import { useMemo } from 'react';
import { Home, Workflow, History } from 'lucide-react';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { useI18n } from '@/lib/i18n/provider';

export function useWeldconnectSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
} {
  const { t } = useI18n();
  const wc = t.navigation.moduleSidebar.weldconnect;
  const groups = t.navigation.moduleSidebar.groups;

  const menuGroups = useMemo((): MenuGroupProps[] => {
    if (!isActive) return [];

    // MVP scope (see app/weldconnect/mvp.ts): only workflows + their runs.
    // Templates, variables, the action/trigger libraries, webhooks,
    // integrations, connectors and analytics are hidden until they're
    // production-ready; their routes still exist.
    return [
      {
        group: groups.general,
        items: [
          { title: wc.overview, href: '/weldconnect', icon: Home },
          { title: wc.workflows, href: '/weldconnect/workflows', icon: Workflow },
          { title: wc.executions, href: '/weldconnect/executions', icon: History },
        ],
      },
    ];
  }, [isActive, wc, groups]);

  return { menuGroups };
}
