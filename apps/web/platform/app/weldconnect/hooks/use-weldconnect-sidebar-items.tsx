import { useMemo } from 'react';
import { Home, Workflow, History, Variable, Webhook, BarChart3, LayoutTemplate, Plug } from 'lucide-react';
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

    // The action/trigger libraries stay hidden (WELDCONNECT_OUT_OF_SCOPE_SECTIONS
    // in app/weldconnect/mvp.ts); their routes still exist. Integrations is where
    // Slack, Google and GitHub get connected for workflow steps. Connectors (the
    // e-commerce sync) has no entry here: Settings → Integrations shows it.
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
          { title: wc.templates, href: '/weldconnect/templates', icon: LayoutTemplate },
          { title: wc.integrations, href: '/weldconnect/integrations', icon: Plug },
          { title: wc.variables, href: '/weldconnect/variables', icon: Variable },
          { title: wc.webhooks, href: '/weldconnect/webhooks', icon: Webhook },
        ],
      },
      {
        group: groups.insights,
        items: [{ title: wc.analytics, href: '/weldconnect/analytics', icon: BarChart3 }],
      },
    ];
  }, [isActive, wc, groups]);

  return { menuGroups };
}
