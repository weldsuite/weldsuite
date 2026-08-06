
import { useMemo } from 'react';
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { useCurrentBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';

interface ConnectHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function ConnectHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: ConnectHeaderProps) {
  const { t } = useI18n();
  const pathname = usePathname();
  const contextBreadcrumbs = useCurrentBreadcrumbs();

  const segments: BreadcrumbSegment[] = useMemo(() => {
    if (contextBreadcrumbs.length > 0) {
      return contextBreadcrumbs;
    }

    const wc = t.navigation.moduleSidebar.weldconnect;
    const routeLabels: Record<string, string> = {
      workflows: wc.workflows,
      templates: wc.templates,
      executions: wc.executions,
      variables: wc.variables,
      webhooks: wc.webhooks,
      integrations: wc.integrations,
      connectors: wc.connectors,
      actions: wc.actions,
      triggers: wc.triggers,
      analytics: wc.analytics,
      edit: t.weldconnect.breadcrumbs.editor,
      settings: t.weldconnect.breadcrumbs.settings,
    };

    const pathParts = pathname.split('/').filter(Boolean);
    const result: BreadcrumbSegment[] = [
      { label: t.weldconnect.breadcrumbs.connect, href: '/weldconnect' },
    ];

    if (pathParts.length === 1) {
      result.push({ label: wc.overview });
      return result;
    }

    for (let i = 1; i < pathParts.length; i++) {
      const part = pathParts[i];
      const href = '/' + pathParts.slice(0, i + 1).join('/');

      if (routeLabels[part]) {
        result.push({ label: routeLabels[part], href });
        continue;
      }

      // Skip dynamic ids (workflow/execution/template detail segments)
      if (/^[a-z0-9_-]{10,}$/i.test(part)) continue;

      const label = part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
      result.push({ label, href });
    }

    return result;
  }, [pathname, t, contextBreadcrumbs]);

  return (
    <BreadcrumbHeader
      segments={segments}
      showBackButton
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="weldconnect"
    />
  );
}
