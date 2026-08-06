
import { useMemo } from 'react';
import {
  Home,
  Workflow,
  BookOpen,
  History,
  Variable,
  Webhook,
  Plug,
  Link2,
  Zap,
  Play,
  BarChart3,
} from 'lucide-react';
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

    return [
      {
        group: groups.general,
        items: [
          { title: wc.overview, href: '/weldconnect', icon: Home },
          { title: wc.workflows, href: '/weldconnect/workflows', icon: Workflow },
          { title: wc.executions, href: '/weldconnect/executions', icon: History },
        ],
      },
      {
        group: groups.library,
        items: [
          { title: wc.templates, href: '/weldconnect/templates', icon: BookOpen },
          { title: wc.variables, href: '/weldconnect/variables', icon: Variable },
          { title: wc.actions, href: '/weldconnect/actions', icon: Zap },
          { title: wc.triggers, href: '/weldconnect/triggers', icon: Play },
        ],
      },
      {
        group: groups.connections,
        items: [
          { title: wc.webhooks, href: '/weldconnect/webhooks', icon: Webhook },
          { title: wc.integrations, href: '/weldconnect/integrations', icon: Plug },
          { title: wc.connectors, href: '/weldconnect/connectors', icon: Link2 },
        ],
      },
      {
        group: groups.insights,
        items: [
          { title: wc.analytics, href: '/weldconnect/analytics', icon: BarChart3 },
        ],
      },
    ];
  }, [isActive, wc, groups]);

  return { menuGroups };
}
